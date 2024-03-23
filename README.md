# Ollamo-Botify
Use the Ollama API to have a simple discord bot.

## Disclaimer
This is based upon the works of this repository below, this was made to be easily deployable purely for docker.
https://github.com/mekb-turtle/discord-ai-bot

## Usage
1. Create a new discord bot at https://discord.com/developers/applications
2. Run the docker image with the following different environment variables:
- `MODEL` - The model to use from Ollama.
- `TOKEN` - The discord bot token.
- `OLLAMA` - The Ollama API location.
- `CHANNELS` - The channels to listen to, separated by commas.

```bash
docker run -e MODEL=orca-mini -e TOKEN=DISCORDTOKEN -e OLLAMA=https://example.com/ -e CHANNELS=12345,678910 ghcr.io/axodouble/ollama-botify:nightly
```

And then you should be set to go.