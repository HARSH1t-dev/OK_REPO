## LIVE LINK

[https://harsh1t-dev.github.io/OK_REPO/](https://harsh1t-dev.github.io/OK_REPO/)

# ISSUE SCOUT

An AI-powered browser extension that analyzes active GitHub issues to provide accurate difficulty tags and step-by-step contribution guides. 

Built specifically to help open-source contributors (especially those targeting GSoC and LFX Mentorships) find meaningful, active issues and avoid stale or superficial "good first issues."

## Features

- **Active Filtering:** Ignores stale issues and surfaces genuinely active ones that meet the qualitative depth required for serious mentorship programs.
- **Smart Analysis:** Uses AI to read issue/PR requirements, identify required programming languages/frameworks, and generate a step-by-step implementation breakdown.
- **True Difficulty Tagging:** Overrides misleading repository tags with accurate `Easy`, `Moderate`, or `Hard` tags based on actual codebase footprint and issue complexity.
- **Maintainer Edge:** Highlights PRs that best align with the repository's architectural goals, helping maintainers choose the best contributions.

## Prerequisites

Before installing the extension, you will need:
1. **An LLM API Key** (e.g., Google Gemini API). You can get a free Gemini API key from [Google AI Studio](https://aistudio.google.com/).
2. *(Optional but recommended)* A **GitHub Personal Access Token** to prevent rate-limiting when fetching repository data.

## Installation

Since this is a custom extension under development, you will need to install it locally via your browser's Developer Mode:

1. Clone or download this repository to your local machine.
2. Open your Chromium-based browser (Chrome, Edge, Brave) and navigate to `chrome://extensions/`.
3. Enable **Developer mode** (usually a toggle in the top right corner).
4. Click on the **Load unpacked** button in the top left.
5. Select the folder containing the extension files (`manifest.json`, `background.js`, etc.).

## Setup

1. Open the extension's code folder.
2. Locate the file handling API requests (e.g., `llm.js` or `background.js`).
3. Replace the placeholder text (e.g., `YOUR_API_KEY_HERE`) with your actual Gemini API key.
4. Save the file.
5. Go back to `chrome://extensions/` and click the circular **Refresh** icon on the extension's card to reload the updated code.

## Usage

1. Navigate to any active open-source repository on GitHub.
2. Go to the **Issues** or **Pull requests** tab.
3. The extension will automatically inject an AI-analyzed summary, genuine difficulty tags, and a step-by-step contribution guide directly into the GitHub UI for relevant issues.

## Tech Stack

- **Extension Framework:** Manifest V3
- **Languages:** HTML, CSS, Vanilla JavaScript
- **AI Integration:** Google Gemini API (or other LLM endpoint)
- **Data Fetching:** GitHub REST API

## Contributing

Pull requests are welcome! If you'd like to improve the UI injection, optimize the prompt, or add multi-LLM support, feel free to fork this repository and submit your changes.
