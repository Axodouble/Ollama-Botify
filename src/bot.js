import {
  Client,
  Events,
  GatewayIntentBits,
  MessageType,
  Partials,
} from "discord.js";
import { Logger, LogLevel } from "meklog";
import axios from "axios";

const model = process.env.MODEL;
const servers = process.env.OLLAMA.split(",").map((url) => ({
  url: new URL(url),
  available: true,
}));
const respondingChannels = [];
const channels = [];
if (process.env.CHANNELS != null) process.env.CHANNELS.split(",");

if (servers.length == 0) {
  throw new Error("No servers available");
}

let log;
process.on("message", (data) => {
  if (data.shardID) client.shardID = data.shardID;
  if (data.logger) log = new Logger(data.logger);
});

const logError = (error) => {
  if (error.response) {
    let str = `Error ${error.response.status} ${error.response.statusText}: ${error.request.method} ${error.request.path}`;
    if (error.response.data?.error) {
      str += ": " + error.response.data.error;
    }
    log(LogLevel.Error, str);
  } else {
    log(LogLevel.Error, error);
  }
};

async function makeRequest(path, method, data) {
  while (servers.filter((server) => server.available).length == 0) {
    // wait until a server is available
    await new Promise((res) => setTimeout(res, 1000));
  }

  let error = null;
  // randomly loop through the servers available, don't shuffle the actual array because we want to be notified of any updates
  let order = new Array(servers.length).fill().map((_, i) => i);

  for (const j in order) {
    if (!order.hasOwnProperty(j)) continue;
    const i = order[j];
    // try one until it succeeds
    try {
      // make a request to ollama
      if (!servers[i].available) continue;
      const url = new URL(servers[i].url); // don't modify the original URL

      servers[i].available = false;

      if (path.startsWith("/")) path = path.substring(1);
      if (!url.pathname.endsWith("/")) url.pathname += "/"; // safety
      url.pathname += path;
      log(LogLevel.Debug, `Making request to ${url}`);
      const result = await axios({
        method,
        url,
        data,
        responseType: "text",
      });
      servers[i].available = true;
      return result.data;
    } catch (err) {
      servers[i].available = true;
      error = err;
      logError(error);
    }
  }
  if (!error) {
    throw new Error("No servers available");
  }
  throw error;
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
  ],
  allowedMentions: { users: [], roles: [], repliedUser: true },
  partials: [Partials.Channel],
});

client.once(Events.ClientReady, async () => {
  await client.guilds.fetch();
  client.user.setPresence({
    status: "online",
    activities: [
      {
        name: "Ollama-Botify",
        type: "WATCHING",
      },
    ],
  });

  // Delete all interactions
  const app = await client.application.fetch();
  const commands = await app.commands.fetch();
  for (const command of commands.values()) {
    await command.delete();
  }
});

const messages = {};

// split text so it fits in a Discord message
function splitText(str, length) {
  // trim matches different characters to \s
  str = str
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/^\s+|\s+$/g, "");
  const segments = [];
  let segment = "";
  let word, suffix;
  function appendSegment() {
    segment = segment.replace(/^\s+|\s+$/g, "");
    if (segment.length > 0) {
      segments.push(segment);
      segment = "";
    }
  }
  // match a word
  while ((word = str.match(/^[^\s]*(?:\s+|$)/)) != null) {
    suffix = "";
    word = word[0];
    if (word.length == 0) break;
    if (segment.length + word.length > length) {
      // prioritise splitting by newlines over other whitespaces
      if (segment.includes("\n")) {
        // append up all but last paragraph
        const beforeParagraph = segment.match(/^.*\n/s);
        if (beforeParagraph != null) {
          const lastParagraph = segment.substring(
            beforeParagraph[0].length,
            segment.length
          );
          segment = beforeParagraph[0];
          appendSegment();
          segment = lastParagraph;
          continue;
        }
      }
      appendSegment();
      // if word is larger than the split length
      if (word.length > length) {
        word = word.substring(0, length);
        if (length > 1 && word.match(/^[^\s]+$/)) {
          // try to hyphenate word
          word = word.substring(0, word.length - 1);
          suffix = "-";
        }
      }
    }
    str = str.substring(word.length, str.length);
    segment += word + suffix;
  }
  appendSegment();
  return segments;
}

let modelInfo = null;

async function replySplitMessage(replyMessage, content) {
  const responseMessages = splitText(content, 2000).map((content) => ({
    content,
  }));

  const replyMessages = [];
  for (let i = 0; i < responseMessages.length; ++i) {
    if (i == 0) {
      replyMessages.push(
        await replyMessage.reply(responseMessages[i]).catch(() => {
          replyMessage.channel.send(responseMessages[i]);
        })
      );
    } else {
      replyMessages.push(
        await replyMessage.channel.send(responseMessages[i]).catch(() => {
          replyMessage.channel.send(responseMessages[i]);
        })
      );
    }
  }
  return replyMessages;
}

let typing = false;

client.on(Events.MessageCreate, async (message) => {
  if (respondingChannels.includes(message.channel.id)) return;
  try {
    await message.fetch();

    // return if not in the right channel
    const channelID = message.channel.id;
    if (!message.guild) return;

    // Check if channels were specified, if not, allow all channels
    if (channels.length > 0 && !channels.includes(channelID)) return;

    // return if user is a bot, or non-default message
    if (!message.author.id) return;
    if (message.author.bot) return;

    const botRole = message.guild?.members?.me?.roles?.botRole;
    const myMention = new RegExp(
      `<@((!?${client.user.id}${botRole ? `)|(&${botRole.id}` : ""}))>`,
      "g"
    ); // RegExp to match a mention for the bot

    if (typeof message.content !== "string" || message.content.length == 0) {
      return;
    }

    let context = null;
    if (message.type == MessageType.Reply) {
      const reply = await message.fetchReference();
      if (!reply) return;
      if (reply.author.id != client.user.id) return;
      if (messages[channelID] == null) return;
      if ((context = messages[channelID][reply.id]) == null) return;
    } else if (message.type != MessageType.Default) {
      return;
    }

    // fetch info about the model like the template and system message
    if (modelInfo == null) {
      modelInfo = await makeRequest("/api/show", "post", {
        name: model,
      });
      if (typeof modelInfo === "string") modelInfo = JSON.parse(modelInfo);
      if (typeof modelInfo !== "object")
        throw "failed to fetch model information";
    }

    // deal with commands first before passing to LLM
    let userInput = message.content
      .replace(new RegExp("^s*" + myMention.source, ""), "")
      .trim();

    if (message.guild) {
      await message.guild.channels.fetch();
      await message.guild.members.fetch();
    }

    userInput = userInput
      .replace(myMention, "")
      .replace(/<#([0-9]+)>/g, (_, id) => {
        if (message.guild) {
          const chn = message.guild.channels.cache.get(id);
          if (chn) return `#${chn.name}`;
        }
        return "#unknown-channel";
      })
      .replace(/<@!?([0-9]+)>/g, (_, id) => {
        if (id == message.author.id) return message.author.username;
        if (message.guild) {
          const mem = message.guild.members.cache.get(id);
          if (mem) return `@${mem.user.username}`;
        }
        return "@unknown-user";
      })
      .replace(/<:([a-zA-Z0-9_]+):([0-9]+)>/g, (_, name) => {
        return `emoji:${name}:`;
      })
      .trim();

    if (userInput.length == 0) return;

    if (!message.mentions.has(client.user.id)) return;
      //if ((channels.length > 0) && (Math.random() < 0.9)) return;

    if (messages[channelID] == null) {
      // create conversation
      messages[channelID] = { amount: 0, last: null };
    }

    // log user's message
    log(
      LogLevel.Debug,
      `${message.guild ? `#${message.channel.name}` : "DMs"} - ${
        message.author.username
      }: ${userInput}`
    );

    // Add the channel to the responding channels
    if (!respondingChannels.includes(channelID)) {
      respondingChannels.push(channelID);
    }

    // start typing
    typing = true;
    await message.channel.sendTyping();
    let typingInterval = setInterval(async () => {
      try {
        await message.channel.sendTyping();
      } catch (error) {
        if (typingInterval != null) {
          clearInterval(typingInterval);
        }
        typingInterval = null;
      }
    }, 7000);

    let response;
    try {
      // context if the message is not a reply
      if (context == null) {
        context = messages[channelID].last;
      }

      // make request to model
      response = await makeRequest("/api/generate", "post", {
        model: model,
        prompt: `${message.author.username}: ${userInput}`,
        context,
      });

      if (typeof response != "string") {
        log(LogLevel.Debug, response);
        throw new TypeError(
          "response is not a string, this may be an error with ollama"
        );
      }

      response = response
        .split("\n")
        .filter((e) => !!e)
        .map((e) => {
          return JSON.parse(e);
        });
    } catch (error) {
      if (typingInterval != null) {
        clearInterval(typingInterval);
      }
      typingInterval = null;
      throw error;
    }

    if (typingInterval != null) {
      clearInterval(typingInterval);
    }
    typingInterval = null;

    let responseText = response
      .map((e) => e.response)
      .filter((e) => e != null)
      .join("")
      .trim();
    if (responseText.length == 0) {
      responseText = "(No response)";
    }

    log(LogLevel.Debug, `Response: ${responseText}`);

    // reply (will automatically stop typing)
    const replyMessageIDs = (
      await replySplitMessage(message, `${responseText}`)
    ).map((msg) => msg.id);

    // add response to conversation
    context = response.filter((e) => e.done && e.context)[0].context;
    for (let i = 0; i < replyMessageIDs.length; ++i) {
      messages[channelID][replyMessageIDs[i]] = context;
    }
    messages[channelID].last = context;
    ++messages[channelID].amount;

    // remove channel from responding channels
    respondingChannels.splice(respondingChannels.indexOf(channelID), 1);
    typing = false;
  } catch (error) {
    if (typing) {
      try {
        // return error
        await message.reply({ content: "Error, please check the console" });
      } catch (ignored) {}
      typing = false;
    }
    logError(error);
  }
});

client.login(process.env.TOKEN);
