"""
CuBERT embedding pipeline — robust, lazy, and extension-friendly.

Highlights:
- Lazy-loads heavy deps (CuBERT model, SentencePiece, PythonTokenizer, Qdrant).
- Clear, actionable error messages (no placeholders).
- Device-safe tensors (honors TORCH_DEVICE, falls back safely).
- Non-destructive Qdrant collection management by default (strict mode optional).
- Path handling via pathlib; env overrides supported via .env or environment.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import List, Tuple, Optional
import os
import sys
import uuid

# Ensure google-research is on sys.path so cubert.* imports work reliably
_REPO_ROOT = Path(__file__).resolve().parents[1]
_GOOGLE_RESEARCH = _REPO_ROOT / "google-research"
if str(_GOOGLE_RESEARCH) not in sys.path:
    sys.path.insert(0, str(_GOOGLE_RESEARCH))

import numpy as np
# Lazy/optional heavy deps so import of this module works without them.
try:
    import torch  # type: ignore
except Exception:
    torch = None  # type: ignore
# Provide a decorator that is a no-op if torch is unavailable
try:
    _inference_mode = torch.inference_mode  # type: ignore[attr-defined]
except Exception:
    def _inference_mode():
        def _decorator(fn):
            return fn
        return _decorator
try:
    from transformers import AutoModel  # type: ignore
except Exception:
    AutoModel = None  # type: ignore
try:
    import sentencepiece as spm  # type: ignore
except Exception:
    spm = None  # type: ignore
from dotenv import load_dotenv

# ----------------------------
# configuration & environment
# ----------------------------

load_dotenv(override=True)  # read .env if present; prefer values from .env over existing env

REPO_ROOT = Path(__file__).resolve().parents[1]

# Paths to google-research/cubert (for PythonTokenizer) and the SentencePiece model
CUBERT_SRC = Path(os.getenv("CUBERT_SRC", _GOOGLE_RESEARCH / "cubert"))
SPM_PATH   = Path(os.getenv("CUBERT_SPM", REPO_ROOT / "cubert_python_tokenizer.spm"))

# Model / runtime
MODEL_NAME   = os.getenv("MODEL_NAME", "claudios/cubert-20210711-Python-512")
MAX_LENGTH   = int(os.getenv("MAX_LENGTH", "512"))
TORCH_DEVICE = os.getenv("TORCH_DEVICE", "cpu")  # e.g. "cpu", "cuda", "cuda:0", "mps")

# Prefer using Hugging Face tokenizer/model end-to-end (skip CuBERT SPM/tokenizer)
# Set USE_HF_ONLY=1 in the environment or .env to force this path.

def _as_bool(x: str | None) -> bool:
    if x is None:
        return False
    return str(x).strip().lower() in {"1", "true", "yes", "on"}

USE_HF_ONLY = _as_bool(os.getenv("USE_HF_ONLY", "0"))

# Qdrant (vector DB)
QDRANT_HOST      = os.getenv("QDRANT_HOST", "localhost")
QDRANT_PORT      = int(os.getenv("QDRANT_PORT", "6333"))
COLLECTION_NAME  = os.getenv("COLLECTION_NAME", "ira-pem-logs")

# ----------------------------
# lazy singletons (loaded on demand)
# ----------------------------

_python_tokenizer_cls = None          # type: ignore
_sp_model = None  # type: ignore  # set when sentencepiece is available
_model: Optional[AutoModel] = None
_qdrant_client = None
_hf_tok = None  # HuggingFace tokenizer fallback (lazy)

def _ensure_cubert_on_path() -> None:
    """Make sure google-research/cubert is importable (for PythonTokenizer)."""
    if not CUBERT_SRC.exists():
        raise FileNotFoundError(
            f"CUBERT_SRC not found: {CUBERT_SRC}\n"
            "Set env CUBERT_SRC to your google-research/cubert folder "
            "(the one containing python_tokenizer.py)."
        )
    p = str(CUBERT_SRC.resolve())
    if p not in sys.path:
        sys.path.insert(0, p)

def load_python_tokenizer_cls():
    """Import the PythonTokenizer class lazily and return the class object."""
    global _python_tokenizer_cls
    if _python_tokenizer_cls is None:
        _ensure_cubert_on_path()
        try:
            from python_tokenizer import PythonTokenizer  # provided by google-research/cubert
        except Exception as e:
            raise ImportError(
                "Failed to import PythonTokenizer from google-research/cubert.\n"
                f"Checked path: {CUBERT_SRC}"
            ) from e
        _python_tokenizer_cls = PythonTokenizer
    return _python_tokenizer_cls

def load_sp() -> "spm.SentencePieceProcessor":
    """Load the SentencePiece model lazily."""
    global _sp_model
    if spm is None:
        raise ImportError(
            "sentencepiece is not installed. Install with `pip install sentencepiece`."
        )
    if _sp_model is None:
        if not SPM_PATH.exists():
            raise FileNotFoundError(
                f"SentencePiece model (.spm) not found: {SPM_PATH}\n"
                "Set env CUBERT_SPM to the correct .spm file."
            )
        sp = spm.SentencePieceProcessor()
        sp.load(str(SPM_PATH))
        _sp_model = sp
    return _sp_model

def _resolve_device(pref: str) -> str:
    """Return the best available device given a preference, with safe fallbacks."""
    # If torch is unavailable, always fall back to CPU
    if torch is None:
        return "cpu"
    pref = (pref or "cpu").lower()
    if pref.startswith("cuda"):
        if torch.cuda.is_available():
            return pref
        if torch.cuda.is_available():
            return "cuda"
        return "cpu"
    if pref == "mps":
        try:
            if torch.backends.mps.is_available():  # type: ignore[attr-defined]
                return "mps"
        except Exception:
            pass
        return "cpu"
    return "cpu"

def load_model() -> "AutoModel":
    """Load the transformer model lazily and move it to the chosen device."""
    global _model, torch, AutoModel
    if _model is None:
        # Import heavy deps lazily so module import doesn't fail without them
        if AutoModel is None:
            try:
                from transformers import AutoModel as _AutoModel  # type: ignore
                AutoModel = _AutoModel  # type: ignore
            except Exception as exc:
                raise ImportError(
                    "transformers is not installed. Install with `pip install transformers`."
                ) from exc
        if torch is None:
            try:
                import torch as _torch  # type: ignore
                torch = _torch  # type: ignore
            except Exception as exc:
                raise ImportError(
                    "PyTorch is not installed. Install with `pip install torch` (or the platform-specific wheel)."
                ) from exc
        try:
            m = AutoModel.from_pretrained(MODEL_NAME)  # type: ignore
            m.eval()
        except Exception as exc:
            raise RuntimeError(
                f"Failed to load model '{MODEL_NAME}'. "
                "Double-check MODEL_NAME and your network/cache."
            ) from exc
        device = _resolve_device(TORCH_DEVICE)
        try:
            m.to(device)
        except Exception:
            # final safety: never crash just for device placement
            m.to("cpu")
        _model = m
    return _model

def get_model_device(model: "AutoModel"):
    # find a parameter tensor to query target device
    try:
        if hasattr(model, "parameters"):
            return next(model.parameters()).device
    except Exception:
        pass
    # Fallback CPU device-like value
    class _CPU:
        type = "cpu"
    return _CPU()

def load_hf_tokenizer():
    """Lazy-load HuggingFace tokenizer as a fallback or primary path.
    We use the Python (non-fast) tokenizer for maximum compatibility.
    """
    global _hf_tok
    if _hf_tok is None:
        from transformers import AutoTokenizer
        _hf_tok = AutoTokenizer.from_pretrained(MODEL_NAME, use_fast=False)
    return _hf_tok

# ----------------------------
# tokenization helpers
# ----------------------------

def tokenize_code(code: str) -> List[str]:
    """Tokenize Python code to tokens using google-research/cubert PythonTokenizer."""
    Tok = load_python_tokenizer_cls()
    tok = Tok()
    # CuBERT tokens expose .text
    return [t.text for t in tok.tokenize(code)]

def tokens_to_ids(tokens: List[str]) -> List[int]:
    """Encode tokens to SentencePiece IDs."""
    sp = load_sp()
    # If BOS/EOS are required for your model, you can wrap with [sp.bos_id(), ..., sp.eos_id()]
    return sp.encode(" ".join(tokens), out_type=int)

def pad_truncate(ids: List[int], max_len: int) -> Tuple[List[int], List[int]]:
    """Truncate to max_len and right-pad with pad_id; return (ids, attention_mask)."""
    sp = load_sp()
    ids = ids[:max_len]
    pad_id = sp.pad_id() if sp.pad_id() >= 0 else 0
    attn = [1] * len(ids)
    if len(ids) < max_len:
        pad_n = max_len - len(ids)
        ids = ids + [pad_id] * pad_n
        attn = attn + [0] * pad_n
    return ids, attn

# ----------------------------
# embedding
# ----------------------------

@_inference_mode()
def get_cubert_embedding(code_snippet: str) -> np.ndarray:
    """
    Convert code into a single embedding (CLS token vector).
    Returns np.float32 array of shape [hidden_dim].

    If `USE_HF_ONLY` is set, or CuBERT SPM/tokenizer assets are missing,
    fall back to Hugging Face tokenizer directly.
    """
    model = load_model()
    device = get_model_device(model)

    # Decide path deterministically to avoid masking real errors
    prefer_hf = USE_HF_ONLY or (not CUBERT_SRC.exists()) or (not SPM_PATH.exists())

    if not prefer_hf:
        # CuBERT-authentic path: PythonTokenizer + SentencePiece
        Tok = load_python_tokenizer_cls()
        tok = Tok()
        tokens = [t.text for t in tok.tokenize(code_snippet)]
        sp = load_sp()
        ids = sp.encode(" ".join(tokens), out_type=int)
        ids = ids[:MAX_LENGTH]
        pad_id = sp.pad_id() if sp.pad_id() >= 0 else 0
        attn = [1] * len(ids)
        if len(ids) < MAX_LENGTH:
            pad_n = MAX_LENGTH - len(ids)
            ids += [pad_id] * pad_n
            attn += [0] * pad_n
        input_ids = torch.tensor([ids], dtype=torch.long, device=device)
        attention_mask = torch.tensor([attn], dtype=torch.long, device=device)
    else:
        # Hugging Face-only path
        tok = load_hf_tokenizer()
        enc = tok(
            code_snippet,
            add_special_tokens=True,
            truncation=True,
            max_length=MAX_LENGTH,
            return_tensors="pt",
        )
        input_ids = enc["input_ids"].to(device)
        attention_mask = enc["attention_mask"].to(device)

    outputs = model(input_ids=input_ids, attention_mask=attention_mask)
    cls = outputs.last_hidden_state[:, 0, :].squeeze(0).detach().cpu().numpy().astype(np.float32)
    return cls

# ----------------------------
# qdrant utilities (lazy client)
# ----------------------------

def get_qdrant():
    """Create the Qdrant client lazily to avoid import-time side effects."""
    global _qdrant_client
    if _qdrant_client is None:
        from qdrant_client import QdrantClient  # import here to keep startup light
        _qdrant_client = QdrantClient(host=QDRANT_HOST, port=QDRANT_PORT)
    return _qdrant_client

def ensure_collection(name: str, dim: int, *, strict_dim: bool = False) -> None:
    """
    Ensure collection exists.
    - strict_dim=False (default): create if missing; do NOT drop/alter existing collections.
    - strict_dim=True: if exists with different dim, recreate it (destructive).
    """
    client = get_qdrant()
    from qdrant_client.models import VectorParams, Distance
    try:
        info = client.get_collection(name)
        if strict_dim:
            current = getattr(getattr(info, "vectors", None), "size", None)
            if current is not None and int(current) != int(dim):
                client.recreate_collection(
                    collection_name=name,
                    vectors_config=VectorParams(size=dim, distance=Distance.COSINE),
                )
    except Exception:
        # not found -> create
        client.create_collection(
            collection_name=name,
            vectors_config=VectorParams(size=dim, distance=Distance.COSINE),
        )

def store_embedding_in_qdrant(embedding: np.ndarray, payload: dict, *, ensure: bool = True, point_id: Optional[str] = None) -> str:
    """
    Upsert a single point. Ensures collection exists by default (non-destructive).
    If `point_id` is provided, use it. Otherwise generate a new UUID.
    Returns the point id as string.
    """
    client = get_qdrant()
    from qdrant_client.models import PointStruct

    vec = np.asarray(embedding, dtype=np.float32)
    if vec.ndim != 1:
        raise ValueError(f"Expected 1D embedding, got shape {vec.shape}")
    if ensure:
        ensure_collection(COLLECTION_NAME, dim=int(vec.shape[0]), strict_dim=False)

    pid = point_id or str(uuid.uuid4())
    point = PointStruct(id=pid, vector=vec.tolist(), payload=payload)
    client.upsert(collection_name=COLLECTION_NAME, points=[point])
    return pid

def fetch_embedding_from_qdrant_by_id(point_id: str) -> Optional[np.ndarray]:
    """Fetch a stored vector by point id. Returns np.ndarray or None if not found."""
    client = get_qdrant()
    try:
        # Modern qdrant-client exposes `retrieve` with with_vectors flag
        recs = client.retrieve(collection_name=COLLECTION_NAME, ids=[point_id], with_vectors=True)
        if not recs:
            return None
        rec = recs[0]
        vec = getattr(rec, "vector", None)
        if vec is None:
            # Some versions store vectors under `vectors` or as dict
            vec = getattr(rec, "vectors", None)
            if isinstance(vec, dict):
                # single-vector collections may store under a default key
                # take the first vector present
                try:
                    vec = next(iter(vec.values()))
                except Exception:
                    vec = None
        if vec is None:
            return None
        return np.asarray(vec, dtype=np.float32)
    except Exception:
        return None


def embed_and_store_pem(code_snippet: str, payload: dict, *, pem_id: Optional[str] = None, ensure: bool = True) -> str:
    """
    Compute an embedding for the provided local code snippet and upsert it with payload.
    If `pem_id` is provided, it is used as the point id. Returns the point id used.
    Intended for ingestion-time use when a PEM is first logged.
    """
    emb = get_cubert_embedding(code_snippet)
    return store_embedding_in_qdrant(emb, payload, ensure=ensure, point_id=pem_id)


def get_or_compute_current_embedding(code_snippet: str, *, pem_point_id: Optional[str] = None, reuse: bool = True) -> Tuple[np.ndarray, Optional[str]]:
    """
    For the current PEM, attempt to reuse an already-stored embedding if `pem_point_id` is provided
    and a vector exists. Otherwise compute a fresh embedding now. Returns (embedding, reused_point_id_or_None).
    This does not store the freshly-computed embedding; the caller may choose to store it after ranking.
    """
    if reuse and pem_point_id:
        vec = fetch_embedding_from_qdrant_by_id(pem_point_id)
        if vec is not None:
            return vec, pem_point_id
    # Fallback: compute now
    emb = get_cubert_embedding(code_snippet)
    return emb, None

# ----------------------------
# example: safe smoke test
# ----------------------------

if __name__ == "__main__":
    try:
        snippet = "c = 1/0"  # trivial snippet to exercise the path
        # Example: try reuse, else compute
        emb, reused_id = get_or_compute_current_embedding(snippet, pem_point_id=None, reuse=True)

        payload = {
            "timestamp": os.getenv("ISO_TIMESTAMP", "2025-08-14T21:38:34.238Z"),
            "pem": "[RUNTIME ERROR] ZeroDivisionError: division by zero",
            "username": os.getenv("USER", "unknown"),
            "activeFile": "example.py",
            "pythonVersion": sys.version.split()[0],
        }

        # Store only if we did not reuse an existing vector
        point_id = reused_id or store_embedding_in_qdrant(emb, payload, ensure=True)
        print("Stored or reused point:", point_id)
    except Exception as e:
        # Show precise failure cause without noisy tracebacks in normal runs
        print(f"[CuBERT] Example failed: {type(e).__name__}: {e}")