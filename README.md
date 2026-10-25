## placeholder apparently 
# might be on maintenance mode for a while since my life's been really busy lately...

Ovelia

A Discord AI bot powered by multiple AI providers, featuring automatic fallback and modular architecture.

Features

- Multi-provider AI — Supports Google Gemini, Groq, and OpenRouter.
- Automatic Fallback — Designed to handle provider failures and switch between available AI providers.
- Modular Architecture — Organized source code for easier maintenance and development.
- Discord Integration — Built with Discord.js.
- Conversation Management — Includes conversation-related utilities.
- Rate Limiting — Includes rate-limit handling.
- Testing — Uses Node.js's built-in test runner.

Tech Stack

- Node.js 20+ (must be above 20+)
- Discord.js
- Google GenAI SDK
- Groq SDK
- OpenAI SDK

Installation

Clone the repository:

git clone <YOUR_REPOSITORY_URL>
cd Ovelia

Install dependencies:

npm install

Configuration

Create a ".env" file in the project root and configure the environment variables required by your Discord bot and AI providers.

Never commit API keys, bot tokens, or other secrets to GitHub.

Usage

Start the bot:

npm start

Development mode:

npm run dev

Run tests:

npm test

Project Structure

Ovelia/
├── index.js
├── src/
│   ├── ai/
│   ├── config/
│   ├── core/
│   ├── discord/
│   ├── storage/
│   └── main.js
├── test/
├── package.json
└── README.md

Development Status

Ovelia is an ongoing project. Features and internal architecture may change as development continues.

License

No license has been specified yet.
