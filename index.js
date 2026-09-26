const {
  Client,
  GatewayIntentBits,
  Partials,
  PermissionsBitField,
  SlashCommandBuilder,
  REST,
  Routes,
  EmbedBuilder
} = require("discord.js");

const fs = require("fs");

const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;

if (!TOKEN || !CLIENT_ID) {
  console.error("❌ TOKEN or CLIENT_ID is missing.");
  process.exit(1);
}

const DATA_FILE = "./data.json";

let data = {};

if (fs.existsSync(DATA_FILE)) {
  try {
    data = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch {
    data = {};
  }
}

function saveData() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildInvites
  ],
  partials: [Partials.GuildMember]
});

const commands = [
  new SlashCommandBuilder()
    .setName("setup")
    .setDescription("Set up the invite system.")
    .addChannelOption(option =>
      option
        .setName("logchannel")
        .setDescription("Channel for invite logs.")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("setrole")
    .setDescription("Give a role automatically at a certain invite amount.")
    .addIntegerOption(option =>
      option
        .setName("invites")
        .setDescription("Number of invites required.")
        .setMinValue(1)
        .setRequired(true)
    )
    .addRoleOption(option =>
      option
        .setName("role")
        .setDescription("Role to give.")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("invites")
    .setDescription("Check someone's invites.")
    .addUserOption(option =>
      option
        .setName("user")
        .setDescription("User to check.")
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName("leaderboard")
    .setDescription("Show the invite leaderboard."),

  new SlashCommandBuilder()
    .setName("config")
    .setDescription("Show the current invite configuration."),

  new SlashCommandBuilder()
    .setName("resetinvites")
    .setDescription("Reset a user's invites.")
    .addUserOption(option =>
      option
        .setName("user")
        .setDescription("User to reset.")
        .setRequired(true)
    )
].map(command => command.toJSON());

client.once("ready", async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);

  const rest = new REST({ version: "10" }).setToken(TOKEN);

  try {
    await rest.put(
      Routes.applicationCommands(CLIENT_ID),
      { body: commands }
    );

    console.log("✅ Slash commands registered.");
  } catch (error) {
    console.error("❌ Command registration error:", error);
  }

  // Save the current invite cache.
  for (const guild of client.guilds.cache.values()) {
    try {
      const invites = await guild.invites.fetch();

      if (!data[guild.id]) {
        data[guild.id] = {
          invites: {},
          settings: {
            logChannel: null,
            roles: []
          }
        };
      }

      data[guild.id].inviteCache = {};

      invites.forEach(invite => {
        data[guild.id].inviteCache[invite.code] = invite.uses || 0;
      });
    } catch (error) {
      console.log(`Could not fetch invites for ${guild.name}`);
    }
  }

  saveData();
});

client.on("guildCreate", async guild => {
  data[guild.id] = {
    invites: {},
    settings: {
      logChannel: null,
      roles: []
    },
    inviteCache: {}
  };

  try {
    const invites = await guild.invites.fetch();

    invites.forEach(invite => {
      data[guild.id].inviteCache[invite.code] = invite.uses || 0;
    });
  } catch {}

  saveData();
});

client.on("guildMemberAdd", async member => {
  const guild = member.guild;

  if (!data[guild.id]) {
    data[guild.id] = {
      invites: {},
      settings: {
        logChannel: null,
        roles: []
      },
      inviteCache: {}
    };
  }

  let usedInvite = null;

  try {
    const oldCache = data[guild.id].inviteCache || {};
    const newInvites = await guild.invites.fetch();

    newInvites.forEach(invite => {
      const oldUses = oldCache[invite.code] || 0;
      const newUses = invite.uses || 0;

      if (newUses > oldUses) {
        usedInvite = invite;
      }
    });

    data[guild.id].inviteCache = {};

    newInvites.forEach(invite => {
      data[guild.id].inviteCache[invite.code] = invite.uses || 0;
    });
  } catch (error) {
    console.log("Could not determine used invite.");
  }

  if (!usedInvite || !usedInvite.inviter) {
    saveData();
    return;
  }

  const inviterId = usedInvite.inviter.id;

  if (!data[guild.id].invites[inviterId]) {
    data[guild.id].invites[inviterId] = 0;
  }

  data[guild.id].invites[inviterId]++;

  const inviteCount = data[guild.id].invites[inviterId];

  // Automatic roles
  const roles = data[guild.id].settings.roles || [];

  for (const roleConfig of roles) {
    if (inviteCount >= roleConfig.invites) {
      const role = guild.roles.cache.get(roleConfig.roleId);

      if (
        role &&
        guild.members.me &&
        role.position < guild.members.me.roles.highest.position
      ) {
        try {
          if (!member.roles.cache.has(role.id)) {
            // Role goes to the inviter, not the new member.
            const inviterMember = await guild.members.fetch(inviterId);

            if (!inviterMember.roles.cache.has(role.id)) {
              await inviterMember.roles.add(role);
            }
          }
        } catch (error) {
          console.log("Could not give automatic role.");
        }
      }
    }
  }

  const logChannelId = data[guild.id].settings.logChannel;

  if (logChannelId) {
    const channel = guild.channels.cache.get(logChannelId);

    if (channel) {
      const embed = new EmbedBuilder()
        .setTitle("📨 New Invite")
        .setDescription(
          `${member} joined using an invite from <@${inviterId}>.`
        )
        .addFields(
          {
            name: "👤 Inviter",
            value: `<@${inviterId}>`,
            inline: true
          },
          {
            name: "📊 Total Invites",
            value: `${inviteCount}`,
            inline: true
          }
        )
        .setTimestamp();

      channel.send({ embeds: [embed] }).catch(() => {});
    }
  }

  saveData();
});

client.on("interactionCreate", async interaction => {
  if (!interaction.isChatInputCommand()) return;

  const guild = interaction.guild;

  if (!guild) {
    return interaction.reply({
      content: "❌ This command can only be used inside a server.",
      ephemeral: true
    });
  }

  if (!data[guild.id]) {
    data[guild.id] = {
      invites: {},
      settings: {
        logChannel: null,
        roles: []
      },
      inviteCache: {}
    };
  }

  const serverData = data[guild.id];

  // /setup
  if (interaction.commandName === "setup") {
    if (
      !interaction.member.permissions.has(
        PermissionsBitField.Flags.ManageGuild
      )
    ) {
      return interaction.reply({
        content: "❌ You need **Manage Server** to use this.",
        ephemeral: true
      });
    }

    const channel = interaction.options.getChannel("logchannel");

    serverData.settings.logChannel = channel.id;

    saveData();

    return interaction.reply({
      content: `✅ Invite logs are now sent to ${channel}.`
    });
  }

  // /setrole
  if (interaction.commandName === "setrole") {
    if (
      !interaction.member.permissions.has(
        PermissionsBitField.Flags.ManageGuild
      )
    ) {
      return interaction.reply({
        content: "❌ You need **Manage Server** to use this.",
        ephemeral: true
      });
    }

    const invites = interaction.options.getInteger("invites");
    const role = interaction.options.getRole("role");

    if (role.managed) {
      return interaction.reply({
        content: "❌ You cannot use a managed/integration role.",
        ephemeral: true
      });
    }

    if (
      guild.members.me &&
      role.position >= guild.members.me.roles.highest.position
    ) {
      return interaction.reply({
        content:
          "❌ I cannot give this role. Move my bot role above that role.",
        ephemeral: true
      });
    }

    serverData.settings.roles =
      serverData.settings.roles.filter(r => r.invites !== invites);

    serverData.settings.roles.push({
      invites,
      roleId: role.id
    });

    serverData.settings.roles.sort((a, b) => a.invites - b.invites);

    saveData();

    return interaction.reply({
      content: `✅ Users will now receive ${role} at **${invites} invites**.`
    });
  }

  // /invites
  if (interaction.commandName === "invites") {
    const user =
      interaction.options.getUser("user") || interaction.user;

    const count = serverData.invites[user.id] || 0;

    return interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle("📨 Invite Stats")
          .setDescription(`${user} has **${count} invites**.`)
          .setTimestamp()
      ]
    });
  }

  // /leaderboard
  if (interaction.commandName === "leaderboard") {
    const sorted = Object.entries(serverData.invites)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);

    if (sorted.length === 0) {
      return interaction.reply("📊 No invites have been tracked yet.");
    }

    let description = "";

    for (let i = 0; i < sorted.length; i++) {
      const [userId, count] = sorted[i];

      description += `**${i + 1}.** <@${userId}> — **${count} invites**\n`;
    }

    return interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle("🏆 Invite Leaderboard")
          .setDescription(description)
          .setTimestamp()
      ]
    });
  }

  // /config
  if (interaction.commandName === "config") {
    const logChannel = serverData.settings.logChannel
      ? `<#${serverData.settings.logChannel}>`
      : "Not configured";

    const roles =
      serverData.settings.roles.length > 0
        ? serverData.settings.roles
            .map(r => `${r.invites} invites → <@&${r.roleId}>`)
            .join("\n")
        : "No automatic roles";

    return interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle("⚙️ Invite Configuration")
          .addFields(
            {
              name: "📢 Log Channel",
              value: logChannel
            },
            {
              name: "🎖️ Automatic Roles",
              value: roles
            }
          )
      ]
    });
  }

  // /resetinvites
  if (interaction.commandName === "resetinvites") {
    if (
      !interaction.member.permissions.has(
        PermissionsBitField.Flags.ManageGuild
      )
    ) {
      return interaction.reply({
        content: "❌ You need **Manage Server** to use this.",
        ephemeral: true
      });
    }

    const user = interaction.options.getUser("user");

    serverData.invites[user.id] = 0;

    saveData();

    return interaction.reply({
      content: `✅ Invite count for ${user} has been reset.`
    });
  }
});

client.login(TOKEN);
