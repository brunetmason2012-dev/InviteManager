const {
  Client,
  GatewayIntentBits,
  PermissionsBitField,
  EmbedBuilder,
  SlashCommandBuilder,
  REST,
  Routes
} = require("discord.js");

const fs = require("fs");

const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;

if (!TOKEN || !CLIENT_ID) {
  console.error("❌ TOKEN or CLIENT_ID is missing.");
  process.exit(1);
}

const DATA_FILE = "./data.json";

let db = {};

if (fs.existsSync(DATA_FILE)) {
  try {
    db = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch {
    db = {};
  }
}

function save() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
}

function getGuild(guildId) {
  if (!db[guildId]) {
    db[guildId] = {
      invites: {},
      inviteCache: {},
      logChannel: null,
      roles: []
    };
    save();
  }

  return db[guildId];
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildInvites
  ]
});

// ==========================
// SLASH COMMANDS
// ==========================

const commands = [
  new SlashCommandBuilder()
    .setName("setup")
    .setDescription("Set up the invite log channel.")
    .addChannelOption(option =>
      option
        .setName("channel")
        .setDescription("Invite log channel")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("setrole")
    .setDescription("Set an automatic invite role.")
    .addIntegerOption(option =>
      option
        .setName("invites")
        .setDescription("Number of invites required")
        .setRequired(true)
        .setMinValue(1)
    )
    .addRoleOption(option =>
      option
        .setName("role")
        .setDescription("Role to automatically give")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("invites")
    .setDescription("Check invite statistics.")
    .addUserOption(option =>
      option
        .setName("user")
        .setDescription("User to check")
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName("leaderboard")
    .setDescription("Show the invite leaderboard."),

  new SlashCommandBuilder()
    .setName("config")
    .setDescription("Show the invite configuration."),

  new SlashCommandBuilder()
    .setName("resetinvites")
    .setDescription("Reset a user's invites.")
    .addUserOption(option =>
      option
        .setName("user")
        .setDescription("User to reset")
        .setRequired(true)
    )
].map(command => command.toJSON());

// ==========================
// READY
// ==========================

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
    console.error("❌ Failed to register commands:", error);
  }

  // Cache existing invites
  for (const guild of client.guilds.cache.values()) {
    const guildData = getGuild(guild.id);

    try {
      const invites = await guild.invites.fetch();

      guildData.inviteCache = {};

      for (const invite of invites.values()) {
        guildData.inviteCache[invite.code] = invite.uses || 0;
      }
    } catch {
      console.log(`⚠️ Could not fetch invites for ${guild.name}`);
    }
  }

  save();
});

// ==========================
// NEW SERVER
// ==========================

client.on("guildCreate", async guild => {
  const guildData = getGuild(guild.id);

  try {
    const invites = await guild.invites.fetch();

    guildData.inviteCache = {};

    for (const invite of invites.values()) {
      guildData.inviteCache[invite.code] = invite.uses || 0;
    }

    save();
  } catch {}
});

// ==========================
// MEMBER JOIN
// ==========================

client.on("guildMemberAdd", async member => {
  const guild = member.guild;
  const guildData = getGuild(guild.id);

  let usedInvite = null;

  try {
    const oldCache = guildData.inviteCache || {};
    const newInvites = await guild.invites.fetch();

    for (const invite of newInvites.values()) {
      const oldUses = oldCache[invite.code] || 0;
      const newUses = invite.uses || 0;

      if (newUses > oldUses) {
        usedInvite = invite;
        break;
      }
    }

    guildData.inviteCache = {};

    for (const invite of newInvites.values()) {
      guildData.inviteCache[invite.code] = invite.uses || 0;
    }
  } catch (error) {
    console.log("⚠️ Could not determine used invite.");
  }

  if (!usedInvite || !usedInvite.inviter) {
    save();
    return;
  }

  const inviterId = usedInvite.inviter.id;

  if (!guildData.invites[inviterId]) {
    guildData.invites[inviterId] = 0;
  }

  guildData.invites[inviterId]++;

  const totalInvites = guildData.invites[inviterId];

  console.log(
    `📨 ${member.user.tag} joined through ${usedInvite.inviter.tag} (${totalInvites} invites)`
  );

  // ==========================
  // AUTOMATIC ROLES
  // ==========================

  for (const roleData of guildData.roles) {
    if (totalInvites < roleData.invites) continue;

    const role = guild.roles.cache.get(roleData.roleId);

    if (!role) continue;

    try {
      const inviterMember = await guild.members.fetch(inviterId);

      if (
        guild.members.me &&
        role.position < guild.members.me.roles.highest.position &&
        !inviterMember.roles.cache.has(role.id)
      ) {
        await inviterMember.roles.add(role);

        console.log(
          `🎉 ${inviterMember.user.tag} received ${role.name}`
        );
      }
    } catch (error) {
      console.log("⚠️ Could not give automatic role.");
    }
  }

  // ==========================
  // INVITE LOG
  // ==========================

  if (guildData.logChannel) {
    const channel = guild.channels.cache.get(
      guildData.logChannel
    );

    if (channel) {
      const embed = new EmbedBuilder()
        .setTitle("📨 New Invite")
        .setDescription(
          `${member} joined the server.`
        )
        .addFields(
          {
            name: "👤 Inviter",
            value: `<@${inviterId}>`,
            inline: true
          },
          {
            name: "📊 Total Invites",
            value: `${totalInvites}`,
            inline: true
          }
        )
        .setTimestamp();

      channel.send({ embeds: [embed] }).catch(() => {});
    }
  }

  save();
});

// ==========================
// COMMANDS
// ==========================

client.on("interactionCreate", async interaction => {
  if (!interaction.isChatInputCommand()) return;

  if (!interaction.guild) {
    return interaction.reply({
      content: "❌ This command can only be used inside a server.",
      ephemeral: true
    });
  }

  const guild = interaction.guild;
  const guildData = getGuild(guild.id);

  // ==========================
  // /setup
  // ==========================

  if (interaction.commandName === "setup") {
    if (
      !interaction.member.permissions.has(
        PermissionsBitField.Flags.ManageGuild
      )
    ) {
      return interaction.reply({
        content: "❌ You need **Manage Server**.",
        ephemeral: true
      });
    }

    const channel = interaction.options.getChannel("channel");

    guildData.logChannel = channel.id;

    save();

    return interaction.reply(
      `✅ Invite logs are now sent to ${channel}.`
    );
  }

  // ==========================
  // /setrole
  // ==========================

  if (interaction.commandName === "setrole") {
    if (
      !interaction.member.permissions.has(
        PermissionsBitField.Flags.ManageGuild
      )
    ) {
      return interaction.reply({
        content: "❌ You need **Manage Server**.",
        ephemeral: true
      });
    }

    const invites = interaction.options.getInteger("invites");
    const role = interaction.options.getRole("role");

    if (role.managed) {
      return interaction.reply({
        content: "❌ You cannot use a managed role.",
        ephemeral: true
      });
    }

    if (
      guild.members.me &&
      role.position >= guild.members.me.roles.highest.position
    ) {
      return interaction.reply({
        content:
          "❌ Move my bot's role above the role you want it to give.",
        ephemeral: true
      });
    }

    guildData.roles = guildData.roles.filter(
      r => r.invites !== invites
    );

    guildData.roles.push({
      invites,
      roleId: role.id
    });

    guildData.roles.sort(
      (a, b) => a.invites - b.invites
    );

    save();

    return interaction.reply(
      `✅ ${role} will automatically be given at **${invites} invites**.`
    );
  }

  // ==========================
  // /invites
  // ==========================

  if (interaction.commandName === "invites") {
    const user =
      interaction.options.getUser("user") ||
      interaction.user;

    const count =
      guildData.invites[user.id] || 0;

    const embed = new EmbedBuilder()
      .setTitle("📨 Invite Stats")
      .setDescription(
        `${user} has **${count} invites**.`
      )
      .setTimestamp();

    return interaction.reply({
      embeds: [embed]
    });
  }

  // ==========================
  // /leaderboard
  // ==========================

  if (interaction.commandName === "leaderboard") {
    const leaderboard = Object.entries(
      guildData.invites
    )
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);

    if (!leaderboard.length) {
      return interaction.reply(
        "📊 No invites have been tracked yet."
      );
    }

    let text = "";

    leaderboard.forEach(
      ([userId, count], index) => {
        text +=
          `**${index + 1}.** <@${userId}> — **${count} invites**\n`;
      }
    );

    const embed = new EmbedBuilder()
      .setTitle("🏆 Invite Leaderboard")
      .setDescription(text)
      .setTimestamp();

    return interaction.reply({
      embeds: [embed]
    });
  }

  // ==========================
  // /config
  // ==========================

  if (interaction.commandName === "config") {
    const logChannel = guildData.logChannel
      ? `<#${guildData.logChannel}>`
      : "Not configured";

    const roles = guildData.roles.length
      ? guildData.roles
          .map(
            r =>
              `**${r.invites} invites** → <@&${r.roleId}>`
          )
          .join("\n")
      : "No automatic roles configured.";

    const embed = new EmbedBuilder()
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
      );

    return interaction.reply({
      embeds: [embed]
    });
  }

  // ==========================
  // /resetinvites
  // ==========================

  if (interaction.commandName === "resetinvites") {
    if (
      !interaction.member.permissions.has(
        PermissionsBitField.Flags.ManageGuild
      )
    ) {
      return interaction.reply({
        content: "❌ You need **Manage Server**.",
        ephemeral: true
      });
    }

    const user =
      interaction.options.getUser("user");

    guildData.invites[user.id] = 0;

    save();

    return interaction.reply(
      `✅ ${user}'s invites have been reset to **0**.`
    );
  }
});

// ==========================
// ERRORS
// ==========================

client.on("error", error => {
  console.error("Discord error:", error);
});

process.on("unhandledRejection", error => {
  console.error("Unhandled rejection:", error);
});

// ==========================
// LOGIN
// ==========================

client.login(TOKEN);
