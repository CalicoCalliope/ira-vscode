# IRA: Interactive Retention-Based Assistant 

**IRA** is a learning-centric IDE plugin designed to empower novice programmers in reading and understanding programming error messages (PEMs) with confidence and autonomy. Unlike traditional LLM-powered assistants that prioritize task completion, IRA supports *learning* by guiding users through tiered explanations, reflective prompts, and personalized feedback, all aimed at reducing frustration and fostering independent debugging skills over time.

## 🔍 Motivation

Programming error messages are often cryptic and frustrating, especially for beginners. Novices frequently struggle to interpret and resolve these messages independently, leading to over-reliance on LLMs or online forums. This bypasses the deeper learning process and can hinder skill development.

IRA challenges this norm by treating PEMs as learning opportunities, not just technical obstacles.

## 🎯 Key Features (MVP)

- **Personal PEM Log**  
  Automatically records each encountered error and its context, powering personalized and adaptive support over time.

- **Retention-Based Conversational Interface**  
  Offers mastery-aware nudges and invites learners to choose what, how, and when they receive guidance.  
  _Example:_ “Don't panic, we've seen this before!”

- **Tiered In-Line APEM Guidance**  
  Presents PEM explanations in structured layers:  
  `Definition/Hint → Reasoning → Fix`  
  Inspired by cognitive scaffolding and learning-stage progression.

## 🛠️ Tech Stack

- **Frontend:** Visual Studio Code (VSCode WebView API)  
- **Backend:** Hugging Face API for LLM-based PEM explanation, MongoDB and Milvus for database services.
- **Logging & Adaptation:** Custom user model to adapt explanation depth and guidance  
- **Languages:** Python, TypeScript

## 🧪 Evaluation Plan

We are conducting a mixed-method evaluation focused on:

- **Learning outcomes:**  
  Pre/post understanding of PEMs, error resolution success, reduced repetition

- **Retention:**  
  Users reattempt previous errors without IRA assistance to assess internalization

- **Pending - Cognitive load & autonomy:**  
  **Measured via NASA-TLX, confidence ratings, and think-aloud usability testing



## 📘 Research Questions

- How can retention-based, learning-focused features in an LLM-assisted IDE affect novice programmers' ability to understand PEMs independently?
- Can such a tool measurably reduce error repetition across sessions?

## 📎 Citation & References

This project builds on a wide body of HCI, CS education, and LLM literature. Key references include:
- Becker et al. (2016, 2019)
- Leinonen et al. (2023)
- Zhou et al. (2021)
- Bouvier et al. (2024)
- Anderson et al. (2001)
- Wass & Golding (2014)

_See full reference list in `docs/references.md`_

---

### 👥 Authors

- Izia Xiaoxiao Wang  
- Yaren Durgun  

---

### 👥  Supervisors

- Dr. Bacchelli
- Dr. Wang

---

### 📅 Project Timeline

See: [`/docs/schedule.pdf`](./docs/schedule.pdf)

---

### 📂 Repo Structure

- TBA
