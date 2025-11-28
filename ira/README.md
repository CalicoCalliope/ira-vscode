# IRA – VS Code Extension

A learning centric VS Code extension that helps novices read and understand Programming Error Messages (PEMs). It captures runtime errors, attaches lightweight context, and sends them to the IRA backend for guidance and analysis.

> **Research-only availability**  
> IRA is an experimental tool operated for University of Zurich research studies. Support is limited to UZH learners and staff who participate in the study.

## Install for the class
1. Download the `.vsix` file provided by the instructors.
2. In VS Code open the Extensions panel, click the three dots, choose **Install from VSIX…**, and select the file.
3. Open **Settings** and search **IRA**.
   - **IRA: Coordinator Endpoint** set to your class backend URL, for example `https://<your-vm-domain-or-ip>`.
   - **IRA: Api Key** leave empty unless your instructor provides one.
4. Restart VS Code.

## Usage
- Open a Python file.
- Run the command **IRA: Run Python and Log Runtime Errors** from the Command Palette.
- When the program throws an error, the extension logs the PEM and sends it to the coordinator endpoint you configured.

## Settings
- `ira.coordinatorEndpoint` string. Base URL of the IRA coordinator service.
- `ira.apiKey` string. Optional API key for the coordinator.

## Availability & support
- Designed for research conducted by the University of Zurich (UZH).
- Only UZH-affiliated learners and facilitators are supported at this time.

## Requirements
- VS Code 1.103.0 or newer.
- Python configured in your workspace so your file can run.

## Known limitations
- This class build focuses on Python error collection.
- Network access to the coordinator must be available from the student device.

## Release notes
### 0.1.0-class.1
- Initial class build. Error capture for Python, configuration for coordinator endpoint, production build with esbuild.

## License
Copyright © 2025 IRA Team. All rights reserved. For research use within the University of Zurich.
