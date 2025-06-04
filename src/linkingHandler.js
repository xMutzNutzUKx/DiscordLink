const config = require('../config.json');
const discord = require('discord.js');
const rustrcon = require('rustrcon');
const fetch = require('node-fetch');
const { readdirSync, unlink } = require('fs');
const chalk = require('chalk');
const { REST } = require('@discordjs/rest');
const { Routes } = require('discord-api-types/v10');

const sqlite3 = require('sqlite3');
let db = new sqlite3.Database('./src/database/database.sqlite3', (err) => {
    if(err) return console.log(err);
});

const _addingRoles = [];
const _removingRoles = [];
const _serverRcons = [];
const _commandQueue = [];
const commands = [];
let _syncRolesArray = [];

if(!config.BOT_TOKEN) return console.log("No bot token defined");
if(!config.STEAM_API_KEY) return console.log("No steam api key defined");

const client = new discord.Client({intents: [discord.GatewayIntentBits.Guilds, discord.GatewayIntentBits.GuildMembers, discord.GatewayIntentBits.GuildEmojisAndStickers, discord.GatewayIntentBits.GuildIntegrations, discord.GatewayIntentBits.GuildWebhooks, discord.GatewayIntentBits.GuildInvites, discord.GatewayIntentBits.GuildVoiceStates, discord.GatewayIntentBits.GuildPresences, discord.GatewayIntentBits.GuildMessages, discord.GatewayIntentBits.GuildMessageReactions, discord.GatewayIntentBits.GuildMessageTyping, discord.GatewayIntentBits.DirectMessages, discord.GatewayIntentBits.DirectMessageReactions, discord.GatewayIntentBits.DirectMessageTyping, discord.GatewayIntentBits.MessageContent], shards: "auto", partials: [discord.Partials.Message, discord.Partials.Channel, discord.Partials.GuildMember, discord.Partials.Reaction, discord.Partials.GuildScheduledEvent, discord.Partials.User, discord.Partials.ThreadMember]});
client.commands = new discord.Collection();
const rest = new REST({ version: '10' }).setToken(config.BOT_TOKEN);

//#region Command Handler
readdirSync('./src/commands').forEach(async file => {
    const command = require(`./commands/${file}`);
    commands.push(command.data.toJSON());
    client.commands.set(command.data.name, command);
});
//#endregion

//#region Bot Hooks
client.on('ready', async () => {
    if(config.LINKING_OPTIONS.LINKING_CHANNEL.ENABLED) CreateLinkingSteps();
    SetActivity(client);
    StartServers();

    setTimeout(async() => {
        try {
            await rest.put(
                Routes.applicationGuildCommands(client.user.id, config.DISCORD_SERVER_ID),
                { body: commands },
            );
        } catch (error) {
            console.error(error);
        }
    }, 30000);
});

client.on('messageCreate', async message => {
    if(message.author.bot) return;
    if(message.channel.type == discord.ChannelType.DM && !config.LINKING_OPTIONS.ALLOW_DM_LINKING) return;
    if(message.channel.type == discord.ChannelType.GuildText && config.LINKING_OPTIONS.LINKING_CHANNEL.ENABLED && !config.LINKING_OPTIONS.LINKING_CHANNEL.CHANNEL_IDS.find(x => x == message.channel.id)) return;
    if(message.channel.type != discord.ChannelType.DM && message.channel.type != discord.ChannelType.GuildText) return;

    if(message.content.length > 6) return message.reply(config.LANG_MESSGAES.InvalidCode);

    await CheckLinkingCode(message.content, message).then(response => {
        if(config.LINKING_OPTIONS.FANCY_REPLIES) FancyReply(message, response);
        else SimpleReply(message, response);
    });
});

client.on('interactionCreate', async interaction => {
    let client = interaction.client;
    if (interaction.type != discord.InteractionType.ApplicationCommand) return;
    if(interaction.user.bot) return;
    try {
        const command = client.commands.get(interaction.commandName)
        command.run(client, interaction)
    } catch(err) {
        interaction.reply({content: config.LANG_MESSGAES.CommandErr, ephemeral: true});
    }

    const embed = new discord.EmbedBuilder().setColor(config.DEFAULT_EMBED_COLOR);

    switch(interaction.commandName) {
        case "force-update-data":
            if(!config.PERMISSIONS.ALLOWED_TO_USE_SYNC_DATA.find(x => interaction.member.roles.cache.has(x))) return interaction.reply({ embeds: [embed.setDescription(config.LANG_MESSGAES.NoPermission)], ephemeral: true });

            db.all("select * from player_info", async function(err, row) {
                if(row == null || row.length == 0) return interaction.reply({ content: "No issues found", ephemeral: true });
                
                let i = 0;
                row.forEach(user => {
                    i++;
                    setTimeout(async () => {
                        let steamData = await GetSteamInfo(user.steam_id);
                        if(typeof steamData != "object") return console.log("Could not find the users steam data!");

                        db.run('update player_info set picture = ?, name = ?, profile_url = ? where steam_id = ?;', [steamData.avatarfull, steamData.personaname, steamData.profileurl, user.steam_id], async function(err, row) {
                            if(err) {
                                console.log("Error while updating user");
                                return;
                            }

                            console.log(`Set data to ${steamData.avatarfull} | ${steamData.personaname} | ${steamData.profileurl}`);
                        });
                    }, i * 2000);
                });
            });
            break;
        case "unlink":
            var isLinked = await CheckIsDiscordLinked(interaction.user.id);
            if(isLinked) SendRconCommand(`discordLink_unlinkPlayer ${isLinked.steam_id}`);
            break;
        case "search-link":
            let re = /7656119([0-9]{10})/gm;
            let sqlCall;
            if(!config.PERMISSIONS.ALLOWED_TO_SEARCH_LINKS.find(x => interaction.member.roles.cache.has(x))) return interaction.reply({ embeds: [embed.setDescription(config.LANG_MESSGAES.NoPermission)], ephemeral: true });

            let interactionOptions = interaction.options._hoistedOptions[0];
            if(!interactionOptions) return interaction.reply({ embeds: [embed.setDescription(config.LANG_MESSGAES.NoneProvided)] });
            let info = interactionOptions.value;

            if(interactionOptions.name == "steam-64-id") {
                let steamId = interactionOptions.value.match(re);

                if(steamId == null) return interaction.reply({ embeds: [embed.setDescription(config.LANG_MESSGAES.IncorrectSteam)] });
                sqlCall = "select * from player_info where steam_id = ?;";
                info = steamId[0];
            } else sqlCall = "select * from player_info where discord_id = ?;" 

            db.all(sqlCall, [info], async function(err, row) {
                if(err) return interaction.reply({ embeds: [embed.setDescription(config.LANG_MESSGAES.DatabaseErr)] });
                if(row.length == 0) return interaction.reply({ embeds: [embed.setDescription(config.LANG_MESSGAES.NoUser)] });

                embed.setFields(
                    { inline: true, name: `Discord ID`, value: `${row[0].discord_id}` },
                    { inline: true, name: `Discord User`, value: `<@${row[0].discord_id}>` },
                    { inline: true, name: `Discord Name`, value: `${row[0].discord_name}` },
                    { inline: true, name: `Steam ID`, value: `${row[0].steam_id}` },
                    { inline: true, name: `Steam Name`, value: `${row[0].name}` },
                    { inline: true, name: `Steam Profile`, value: `[${row[0].name}](${row[0].profile_url})` }
                )
                .setFooter({ text: "Player searched" })
                .setTimestamp();

                interaction.reply({ embeds: [embed], ephemeral: true });
            });
            break;
        case "sync-link":
            const syncName = interaction.options._hoistedOptions[0].value;
            const guild = client.guilds.cache.get(config.DISCORD_SERVER_ID);
            let theJson;

            if(!config.PERMISSIONS.ALLOWED_TO_USE_SYNC_DATA.find(x => interaction.member.roles.cache.has(x))) return interaction.reply({ embeds: [embed.setDescription(config.LANG_MESSGAES.NoPermission)], ephemeral: true });
            let attachment = await fetch(interaction.options._hoistedOptions[1].attachment.attachment).then(res => res.text());
            if(syncName == "discordlink") attachment = attachment.replace(/("SteamId"\s*:\s*)(\d{17})/g, '$1"$2"'); 

            try {
                theJson = JSON.parse(attachment);         
                } catch(err) {
                console.log(err);
                return;
            }

            let i = 0;
            let infoString = "";
            let currentLinked;
            let oldLinked;
            let userCount;
            let playerInfoArray = [];
            switch(syncName) {
                case "steamcord":
                    infoString = `**Importing:** ${theJson.length} users\n**Rate:** 1 user per 5 seconds (Rate limits)\n**EST Total time:** ${((theJson.length * 5) / 60).toFixed(2)} minute(s)`;
                    interaction.reply({ embeds: [embed.setDescription(infoString)] });

                    i = 0;
                    theJson.forEach(player => {
                        i++;
                        setTimeout(() => {
                            if(player.discordAccounts.length == 0 || player.steamAccounts.length == 0) return;
                            let discordInfo = player.discordAccounts[0];
                            let steamInfo = player.steamAccounts[0];

                            AddSyncDB(steamInfo.steamId, discordInfo.discordId, true, guild, {discordName: discordInfo.username });
                        }, i * 5000);
                    });
                    break;
                case "discordcore":
                    currentLinked = theJson.PlayerDiscordInfo;
                    oldLinked = theJson.LeftPlayerInfo;
                    userCount = Object.keys(currentLinked).length;
                    if(oldLinked != undefined && oldLinked != null) userCount = userCount + Object.keys(oldLinked).length;

                    infoString = `**Importing:** ${userCount} users\n**Rate:** 1 user per 5 seconds\n**EST Total time:** ${((userCount * 5) / 60).toFixed(2)} minute(s)`;
                    interaction.reply({ embeds: [embed.setDescription(infoString)] });

                    for(let key in currentLinked) playerInfoArray.push({ PlayerId: currentLinked[key].PlayerId, DiscordId: currentLinked[key].DiscordId, ActiveLink: true });
                    for(let key in oldLinked) playerInfoArray.push({ PlayerId: oldLinked[key].PlayerId, DiscordId: oldLinked[key].DiscordId, ActiveLink: false });

                    playerInfoArray.forEach(player => {
                        i++;
                        setTimeout(() => {
                            AddSyncDB(player.PlayerId, player.DiscordId, player.ActiveLink, guild);
                        }, i * 5000);
                    });
                    break;
                case "discordauth":
                    currentLinked = theJson.Players;
                    oldLinked = theJson.Backup;
                    userCount = Object.keys(currentLinked).length;
                    if(oldLinked != undefined && oldLinked != null) userCount = userCount + Object.keys(oldLinked).length;
                    infoString = `**Importing:** ${userCount} users\n**Rate:** 1 user per 5 seconds\n**EST Total time:** ${((userCount * 5) / 60).toFixed(2)} minute(s)`;
                    interaction.reply({ embeds: [embed.setDescription(infoString)] });

                    for(let key in currentLinked) playerInfoArray.push({ PlayerId: key, DiscordId: currentLinked[key], ActiveLink: true });    
                    for(let key in oldLinked) playerInfoArray.push({ PlayerId: key, DiscordId: oldLinked[key], ActiveLink: true }); 

                    playerInfoArray.forEach(player => {
                        i++;
                        setTimeout(() => {
                            AddSyncDB(player.PlayerId, player.DiscordId, player.ActiveLink, guild);
                        }, i * 5000);
                    });
                    break;
                case "discordlink":
                    console.log(theJson);
                    currentLinked = theJson;                   
                    infoString = `**Importing:** ${currentLinked.length} users\n**Rate:** 1 user per 5 seconds\n**EST Total time:** ${((currentLinked.length * 5) / 60).toFixed(2)} minute(s)`;

                    interaction.reply({ embeds: [embed.setDescription(infoString)] });
                    currentLinked.forEach(player => {
                        i++;
                        setTimeout(() => {
                            AddSyncDB(player.SteamId, player.DiscordId, true, guild);
                        }, i * 5000);
                    });
                    break;
            }
            break;
    }
});

function AddSyncDB(steamId, discordId, activeLink, guild, extraInfo = {}) {
    db.get("select * from player_info where steam_id = ? and discord_id = ?", [steamId, discordId], async function(err, row) {
        if(err || row) return;

        const member = guild.members.cache.get(discordId);
        let shouldLink = true;
        let profilePicture;
        if(member == undefined || !activeLink) shouldLink = false;

        let time = (Date.now() / 1000).toString();
        if(time.includes('.')) time = time.split(".")[0];

        let userName = null;
        if(member != undefined) userName = member.displayName;
        else if(extraInfo.discordName != null) username = extraInfo.discordName;

        let steamInfo = await GetSteamInfo(steamId);
        if(shouldLink) {
            let doesBoost = member.premiumSince != null;
            if(member.avatar != null) profilePicture = `https://cdn.discordapp.com/guilds/${config.DISCORD_SERVER_ID}/users/${member.id}/avatars/${member.avatar}.png`;
            else profilePicture = member.user.displayAvatarURL().split(".webp")[0] + ".png";

            db.run("insert into player_info (steam_id, discord_id, picture, name, profile_url, linked_date, discord_name, isBooster, isLinked, lastUpdated) values (?,?,?,?,?,?,?,?,?,?);", [steamId, discordId, steamInfo.avatarfull, steamInfo.parsonaname, steamInfo.profileurl, time, userName, doesBoost, shouldLink, time ]);
            SendRconCommand(`discordLink_updatePlayer ${steamId} ${discordId} true ${doesBoost} ${profilePicture} ${steamInfo.avatarfull} ${userName}`);
        }
        else db.run("insert into player_info (steam_id, discord_id, picture, name, profile_url, linked_date, isBooster, isLinked, lastUpdated, discord_name) values (?,?,?,?,?,?,?,?,?,?);", [steamId, discordId, steamInfo.avatarfull, steamInfo.personaname, steamInfo.profileurl, time, false, false, time, extraInfo.discordName ]);
    });
}

client.on("guildMemberRemove", async member => {
    const isLinked = await CheckIsDiscordLinked(member.id);

    if(isLinked) SendRconCommand(`discordLink_unlinkPlayer ${isLinked.steam_id}`);
});

client.on("guildMemberUpdate", async(oldStatus, newStatus) => {
    let wasBooster = oldStatus.premiumSince != null;
    let isBooster = newStatus.premiumSince != null;
    let oldRoles = oldStatus.roles.member._roles;
    let newRoles = newStatus.roles.member._roles;
    let oldPFP = oldStatus.avatar;
    let newPFP = newStatus.avatar;
    let isLinked = await CheckIsDiscordLinked(newStatus.id);
    if(!isLinked) return;

    if(wasBooster != isBooster) {
        UpdateDatabase(newStatus.user.username, isBooster, newStatus.user.id);
        SendRconCommand(`discordLink_updatePlayer ${isLinked.steam_id} ${newStatus.id} true ${isBooster} ${profilePicture} false ${newStatus.displayName}`);
    } else if(oldRoles.length != newRoles.length) {
        let addedRoles = newStatus.roles.member._roles.filter(x => !oldStatus.roles.cache.has(x));
        let removedRoles = oldStatus.roles.member._roles.filter(x => !newStatus.roles.cache.has(x));

        for(let role of addedRoles) {
            if(!_syncRolesArray.find(x => x == role)) continue;
            
            var add = _addingRoles.find(x => x.discordId == oldStatus.id);
            if(add != undefined) {
                const index = add.roles.indexOf(2);
                add.roles.splice(index, 1);
            } else {
                SendRconCommand(`discordLink_roleChanged ${newStatus.id} ${role} true`);
            }
        }

        for(let role of removedRoles) {
            if(!_syncRolesArray.find(x => x == role)) continue;

            var remove = _removingRoles.find(x => x.discordId == oldStatus.id);
            if(remove != undefined) {
                const index = remove.roles.indexOf(2);
                remove.roles.splice(index, 1);
            } else {
                SendRconCommand(`discordLink_roleChanged ${newStatus.id} ${role} false`);
            }
        }
    } else if(config.SYNC_STEAM_NAMES_TO_DISCORD && isLinked.name != newStatus.nickname) {
        if(newStatus.guild.ownerId != newStatus.user.id) newStatus.setNickname(isLinked.name);
    } else if(newPFP != oldPFP) {

        let profilePicture;
        if(newPFP != null) profilePicture = `https://cdn.discordapp.com/guilds/${config.DISCORD_SERVER_ID}/users/${newStatus.id}/avatars/${newStatus.avatar}.png`;
        else profilePicture = newStatus.user.displayAvatarURL().split(".webp")[0] + ".png";

        SendRconCommand(`discordLink_updatePlayer ${isLinked.steam_id} ${newStatus.id} true ${isBooster} ${profilePicture} false ${newStatus.displayName}`);
    }
});

client.login(config.BOT_TOKEN);
//#endregion

//#region RCON Handlers
function StartServers() {
    config.SERVERS.forEach((server, index) => {
        let RconIP = server.SERVER_IP;
        let StartRoleSync;
        let DidSync = false;
        server.checkNewItems;
        server.connected = false;
        if(!server.SERVER_ENABLED) return;
        if(!server.SERVER_IP) return console.log(`You have not provided a server IP for me to use for server (${server.SERVER_SHORTNAME} | INDEX: ${index + 1})`);
        if(!server.RCON_PASS) return console.log(`You have not provided a server Password for me to use for server (${server.SERVER_SHORTNAME} | INDEX: ${index + 1})`);
        if(!server.RCON_PORT) return console.log(`You have not provided a server Port for me to use for server (${server.SERVER_SHORTNAME} | INDEX: ${index + 1})`);
        if(server.SERVER_IP.includes(":")) RconIP = RconIP.slice(":")[0];

        const rcon = new rustrcon.Client({
            ip: RconIP,
            port: server.RCON_PORT,
            password: server.RCON_PASS
        });

        _serverRcons.push(rcon);

        runConnection();

        rcon.on('connected', () => {
            console.log(`💚 Successfully connected to ${chalk.green(server.SERVER_SHORTNAME)}`);
            server.connected = true;
            StartRoleSync = setInterval(() => {
                GetRoleSync(rcon);
            }, 30000);
        });

        rcon.on('disconnect', () => {
            clearInterval(StartRoleSync);
            if(server.connected) {
                server.connected = false;
                console.log(`❤️ Dropped connection to ${chalk.red(server.SERVER_SHORTNAME)}`);
            } else console.log(`💛 Failed to connect to ${chalk.yellow(server.SERVER_SHORTNAME)}`);

            setTimeout(() => runConnection(), 30000);
        });

        rcon.on('error', err => {
            console.log(`❤️ Encountered an error while tring to connect to ${chalk.red(server.SERVER_SHORTNAME)}\n--------- [ ${chalk.red("ERROR")} ] ---------\n${err.message}\n-----------------------------`);
        });

        function runConnection() {
            console.log(`💜 Attempting a connection to ${chalk.magenta(server.SERVER_SHORTNAME)}`);
            rcon.login();
        }

        rcon.on('message', async(message) => {
            let messageContent = message.content;
            let messageIdentifier = message.Identifier;
            if(messageIdentifier == -1) {
                if(messageContent.length < 1) return;
                if(typeof messageContent == "object") return;
                if(!messageContent.includes("DiscordLink")) return;
                messageContent = messageContent.replace("\n", "");
                let action = messageContent.slice(0, messageContent.indexOf('||')).split(".")[1];
                let theJson = JSON.parse(messageContent.slice(messageContent.indexOf("||") + 2));

                switch(action) {
                    case "Generated":
                        AddCodeToDatabase(theJson);
                        break;
                    case "Unlinked":
                        UnlinkPlayer(theJson.steamId, true);
                        break;
                    case "RoleChanged":
                        RoleChanged(theJson);
                        break;
                    case "CheckStatus":
                        CheckLinkStatus(theJson);
                        break;
                    case "VerifyUnlink":
                        SendRconCommand(`discordLink_unlinkPlayer ${theJson.SteamID}`);
                        break;
                    case "RolesToSync":
                        theJson.rolesToSync.forEach(role => { if(!_syncRolesArray.includes(role)) _syncRolesArray.push(role) });    
                        if(!DidSync) {
                            StartRoleSync = null;
                            DidSync = true;
                        }                
                        break;
                }
            }
        });
    });
}
//#endregion

//#region Methods
async function CheckLinkStatus(theJson) {
    const isLinked = await CheckIsSteamLinked(theJson.steamId);
    if(!isLinked) return;

    const guild = client.guilds.cache.get(config.DISCORD_SERVER_ID);
    const member = guild.members.cache.get(isLinked.discord_id);
    let lastUpdate = isLinked.lastUpdated;
    let steamData = { name: isLinked.name, profile_url: isLinked.profile_url, picture: isLinked.picture };
    let profilePicture;

    if(lastUpdate + config['UPDATE_STEAM_INFO (Every x hours on player join)'] < Date.now()) {
        const steamInfo = await GetSteamInfo(theJson.steamId);
        if(typeof steamInfo != "object") return;
        steamData = { name: steamInfo.personaname, profile_url: steamInfo.profileurl, picture: steamInfo.avatarfull };
        lastUpdate = `${Date.now() / 1000}`;
        if(lastUpdate.includes('.')) lastUpdate = lastUpdate.split(".")[0];

        db.run('update player_info set picture = ?, name = ?, profile_url = ?, lastUpdated = ? where steam_id = ? and isLinked = ?', [steamData.picture, steamData.personaname, steamData.profile_url, lastUpdate, isLinked.steam_id, true]);
    }
    
    theJson.groups.forEach(role => {  
        if(!member.roles.cache.has(role.Value)) {
            var add = _addingRoles.find(x => x.discordId == member.id);
            if(add != undefined) {
                add.roles.push(role.Value);
            } else {
                _addingRoles.push({ discordId: member.id, roles: [role] });
            }

            member.roles.add(role.Value);
        }
    });

    _syncRolesArray.forEach(role => {  
        if(member.roles.cache.has(role) && !theJson.groups.includes(x => x.Value))
            {
                var remove = _removingRoles.find(x => x.discordId == member.id);
                if(remove != undefined) {
                    remove.roles.push(role.Value);
                } else {
                    _removingRoles.push({ discordId: member.id, roles: [role] });
                }

                member.roles.remove(role);
            }
     });

    if(member.avatar != null) profilePicture = `https://cdn.discordapp.com/guilds/${config.DISCORD_SERVER_ID}/users/${member.id}/avatars/${member.avatar}.png`;
    else profilePicture = member.user.displayAvatarURL().split(".webp")[0] + ".png";

    SendRconCommand(`discordLink_updatePlayer ${isLinked.steam_id} ${isLinked.discord_id} true ${member.premiumSince != null} ${profilePicture} ${steamData.picture} ${member.displayName}`);
    if(config.SYNC_STEAM_NAMES_TO_DISCORD && guild.ownerId != member.id) member.setNickname(steamData.name);
}

async function RoleChanged(theJson) {
    const isLinked = await CheckIsDiscordLinked(theJson.discordId);
    if(!isLinked) return;

    const guild = client.guilds.cache.get(config.DISCORD_SERVER_ID);
    const member = guild.members.cache.get(theJson.discordId);

    if(member == undefined || member == null) return;
    if(theJson.roleId.length < 10 || parseInt(theJson.roleId) == undefined) return;

    if(theJson.added) member.roles.add(theJson.roleId);
    else member.roles.remove(theJson.roleId);
}

function GetRoleSync(rcon) {
    try { rcon.send("discordLink_getRolesToSync", "DiscordLink", 200); } catch(err) { 
        if(err.toString().includes("WebSocket is not open")) return; 
        else console.log(err);
    };
}

function UpdateDatabase(userName, isBooster, discordId) {
    db.run("update player_info set discord_name = ?, isBooster = ? where discord_id = ?;", [userName, isBooster, discordId])
}

async function UnlinkPlayer(steamId, fromServer = false) {
    const isLinked = await CheckIsSteamLinked(steamId);

    const guild = client.guilds.cache.get(config.DISCORD_SERVER_ID);
    const member = guild.members.cache.get(isLinked.discord_id);

    if(member != undefined && member != null) {
        config['LINKED_ROLE(S)'].forEach(role => {
            if(role.length > 10 && parseInt(role) != undefined) member.roles.remove(role);
        });

        _syncRolesArray.forEach(role => {
            if(role.length > 10 && parseInt(role) != undefined) member.roles.remove(role);
        });
    }

    if(isLinked) {
        db.run("update player_info set isLinked = ? where steam_id = ?;", [false, steamId]);
        SendUnlinkEmbed(isLinked);
    }
}

function AddCodeToDatabase(info) {
    db.get("select * from saved_codes where userId = ?;", [info.userId], async function(err, row) {
        if(row) db.run("update saved_codes set code = ?, displayName = ? where userId = ?", [info.code, info.displayName, info.userId]);
        else db.run("INSERT INTO saved_codes (userId, displayName, code) VALUES (?, ?, ?);", [info.userId, info.displayName, info.code]);
    });
}

function CheckLinkingCode(code, message) {
    return new Promise((resolve, reject) => {
        db.get("select * from saved_codes where code = ?;", [code], async function(err, row) {
            if(err) {
                console.log(err);
                resolve(config.LANG_MESSGAES.DatabaseErr);
            }

            if(!row || row == undefined || row.code != code) return resolve(config.LANG_MESSGAES.InvalidCode);
            let isLinked = await CheckIsLinked(message, row.userId);

            if(isLinked) return resolve(config.LANG_MESSGAES.AlreadyLinked.replace("{0}", isLinked.name).replace("{1}", isLinked.profile_url));
            resolve(await LinkUser(row.userId, message));
        });
    });
}

async function LinkUser(steamId, message) {
    return new Promise(async (resolve, reject) => {
        let steamInfo = await GetSteamInfo(steamId);

        if(typeof steamInfo != "object") {
            if(config.LINKING_OPTIONS.FANCY_REPLIES) FancyReply(message, steamInfo);
            else SimpleReply(message, steamInfo);
            return;
        }

        let profilePicture = message.author.displayAvatarURL();
        if(profilePicture.includes(".webp")) profilePicture.split(".")[0] + ".png";
        const guild = client.guilds.cache.get(config.DISCORD_SERVER_ID);
        let member = guild.members.cache.get(message.author.id);
        let alreadyLinked = false;
        let time = (Date.now() / 1000).toString();
        if(time.includes('.')) time = time.split(".")[0];

        let doesBoost = member.premiumSince != null;
        if(member.avatar != null) profilePicture = `https://cdn.discordapp.com/guilds/${config.DISCORD_SERVER_ID}/users/${member.id}/avatars/${member.avatar}.png`;

        db.get("select * from player_info where discord_id = ? and steam_id = ?;", [message.author.id, steamId], async function(err, row) {
            if(!row) db.run("insert into player_info (steam_id, discord_id, picture, name, profile_url, linked_date, discord_name, isBooster, isLinked, lastUpdated) values (?,?,?,?,?,?,?,?,?,?);",
            [steamId, message.author.id, steamInfo.avatarfull, steamInfo.personaname, steamInfo.profileurl, time, message.author.username, doesBoost, true, time]);
            else {
                alreadyLinked = true;
                db.run("update player_info set isLinked = ? where steam_id = ? and discord_id = ?;", [true, steamId, message.author.id]);
            };

            if(config.SYNC_STEAM_NAMES_TO_DISCORD && guild.ownerId != message.author.id) message.member.setNickname(steamInfo.personaname);

            config.COMMANDS_ON_LINK.forEach(cmd => {
                if(cmd.ONLY_ON_FIRST_LINK && alreadyLinked) return;
                SendRconCommand(cmd.COMMAND.replace("{steamid}", steamId).replace("{name}", steamInfo.personaname), true);
            });
        });
    
        db.run("delete from saved_codes where userId = ?;", [steamId]);

        SendRconCommand(`discordLink_updatePlayer ${steamId} ${message.author.id} true ${doesBoost} ${profilePicture} ${steamInfo.avatarfull} ${message.author.username}`);

        config['LINKED_ROLE(S)'].forEach(role => { if(role.length > 10 && parseInt(role) != undefined) member?.roles.add(role) });

        _syncRolesArray.forEach(role => { if(member.roles.cache.has(role)) SendRconCommand(`discordLink_roleChanged ${message.author.id} ${role} true`) })

        if(config.LINK_LOGS_CHANNEL) SendLinkEmbed(message, steamInfo, time);

        resolve(config.LANG_MESSGAES.SuccessLink.replace("{0}", steamInfo.personaname).replace("{1}", steamInfo.profileurl));
    });
}

setTimeout(() => {
    if(!_commandQueue.length == 0) return;
    _commandQueue.forEach(command => {
        try {
            _serverRcons[command.id].send(`${command}`, "discordLink", 200);
            const arrayIndex = _serverRcons.indexOf(2);
            _serverRcons.splice(arrayIndex, arrayIndex);
        } catch(err) {

        }
    });
}, 60000);

function SendRconCommand(command, isConfigCommand = false, isUnlinkCommand = false) {
    _serverRcons.forEach((rcon, index) => {
        try {
            rcon.send(`${command}`, "discordLink", 200);
            if(isConfigCommand && config.SUCCESSFULLY_RAN_COMMANDS_WEBHOOK) {
                let webhook = new discord.WebhookClient({ url: config.SUCCESSFULLY_RAN_COMMANDS_WEBHOOK });
                const embed = new discord.EmbedBuilder().setColor(isUnlinkCommand ? "#5496ff" : "#54ff76")
                .setDescription(`**SENT (${index})**: `+ "``" + command + "``");
                webhook.send({ embeds: [embed] });                
            }
        } catch(err){
            console.log(err);

            if(isConfigCommand && config.SUCCESSFULLY_RAN_COMMANDS_WEBHOOK) {0
                let webhook = new discord.WebhookClient({ url: config.SUCCESSFULLY_RAN_COMMANDS_WEBHOOK });
                const embed = new discord.EmbedBuilder().setColor("#ff5454")
                .setDescription(`**COULDNT SEND (${index}):** `+ "``" + command + "``");
                webhook.send({ embeds: [embed] });
            }

            _commandQueue.push({ rconId: index, command: command });
        }
    });
}

function SendUnlinkEmbed(dbInfo) {
    let unlinkTime = (Date.now() / 1000).toString();

    config.COMMANDS_ON_UNLINK.forEach(cmd => {
        SendRconCommand(cmd.replace("{steamid}", dbInfo.steam_id), true, true);
    });

    if(unlinkTime.includes('.')) unlinkTime = unlinkTime.split('.')[0];
    let fields = [
        { inline: true, name: `Discord ID`, value: `${dbInfo.discord_id}` },
        { inline: true, name: `Discord User`, value: `<@${dbInfo.discord_id}>` },
        { inline: true, name: `Discord Name`, value: `${dbInfo.discord_name}` },
        { inline: true, name: `Steam ID`, value: `${dbInfo.steam_id}` },
        { inline: true, name: `Steam Name`, value: `${dbInfo.name}` },
        { inline: true, name: `Steam Profile`, value: `[${dbInfo.name}](${dbInfo.profile_url})` }
    ]

    let body = { color: config.UNLINK_EMBED_COLOR, thumbnail: dbInfo.picture, description: `**Linked <t:${dbInfo.linked_date}>**\n**Unlinked <t:${unlinkTime}>**`, fields: fields, footer: {text: "Player Unlinked"} };
    FancyReply(false, body, config.UNLINK_LOGS_CHANNEL);
}

function SendLinkEmbed(message, steamInfo, time) {
    let fields = [
        { inline: true, name: `Discord ID`, value: `${message.author.id}` },
        { inline: true, name: `Discord User`, value: `<@${message.author.id}>` },
        { inline: true, name: `Discord Name`, value: `${message.author.username}` },
        { inline: true, name: `Steam ID`, value: `${steamInfo.steamid}` },
        { inline: true, name: `Steam Name`, value: `${steamInfo.personaname}` },
        { inline: true, name: `Steam Profile`, value: `[${steamInfo.personaname}](${steamInfo.profileurl})` }
    ]

    let body = { color: config.LINK_EMBED_COLOR, thumbnail: steamInfo.avatarfull, description: `**Linked <t:${time}>**`, fields: fields, footer: {text: "Player Linked"} };
    FancyReply(message, body, config.LINK_LOGS_CHANNEL);
}

async function GetSteamInfo(steamId) {
    return new Promise((resolve, reject) => {
        fetch(`https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/?key=${config.STEAM_API_KEY}&steamids=${steamId}`).then(res => res.text()).then(steam => {
            try {
                steam = JSON.parse(steam);
                if(!steam.response.players[0]) return;
                const { personaname, avatarfull, profileurl, steamid, communityvisibilitystate } = steam.response.players[0];

                resolve({ 'personaname': personaname, 'avatarfull': avatarfull, 'profileurl': profileurl, 'steamid': steamid, 'profilestatus': communityvisibilitystate });
            } catch (err) {
                console.log(err);
                resolve(config.LANG_MESSGAES.SteamErr);
            }

        });    
    });
}

function CheckIsLinked(message, steamId) {
    return new Promise((resolve, reject) => {
        db.get("select * from player_info where discord_id = ? and steam_id = ? and isLinked = ?;", [message.author.id, steamId, true], async function(err, row) {
            if(err) {
                console.log(err);
                return resolve(config.LANG_MESSGAES.DatabaseErr);
            }

            if(!row || row == undefined) resolve(false);
            else resolve(row);
        });
    });
}

function CheckIsDiscordLinked(discordId) {
    return new Promise((resolve, reject) => {
        db.get("select * from player_info where discord_id = ? and isLinked = ?;", [discordId, true], async function(err, row) {
            if(err) {
                console.log(err);
                return resolve(config.LANG_MESSGAES.DatabaseErr);
            }

            if(!row || row == undefined) resolve(false);
            else resolve(row);
        });
    });
}

function CheckIsSteamLinked(steamId) {
    return new Promise((resolve, reject) => {
        db.get("select * from player_info where steam_id = ? and isLinked = ?;", [steamId, true], async function(err, row) {
            if(err) {
                console.log(err);
                return resolve(config.LANG_MESSGAES.DatabaseErr);
            }

            if(!row || row == undefined) resolve(false);
            else resolve(row);
        });
    });
}

function FancyReply(message, body, isChannel = false) {
    const embed = new discord.EmbedBuilder();
    
    if(typeof body != "object") embed.setDescription(body);
    else {
        if(body.color) embed.setColor(body.color);
        if(body.thumbnail) embed.setThumbnail(body.thumbnail);
        if(body.description) embed.setDescription(body.description);
        if(body.fields) embed.setFields(body.fields);
        if(body.footer) embed.setFooter(body.footer).setTimestamp();
    }

    if(isChannel) {
        const channel = client.channels.cache.get(isChannel);
        channel.send({ embeds: [embed] });
    } else {
        if(message.channel.type == discord.ChannelType.DM) return message.reply({ embeds: [embed] });
        message.reply({ embeds: [embed] }).then(msg => {
            setTimeout(() => {
                    message.delete();
                    msg.delete();
            }, 5000);
        });
    }
}

function SimpleReply(message, body, isChannel = false) {
    if(isChannel) {
        const channel = client.channels.cache.get(isChannel);
        channel.send(body);
    } else {
        if(message.channel.type == discord.ChannelType.DM) return message.reply(body);
        message.reply(body).then(msg => {
            setTimeout(() => {
                    message.delete();
                    msg.delete();
            }, 5000);
        });
    }
}

async function SetActivity(client) {
    let currentActivity = discord.ActivityType.Watching;;
	let activityTypes = [ 
		{ type: "competing", oType: discord.ActivityType.Competing },
		{ type: "listening", oType: discord.ActivityType.Listening },
		{ type: "playing", oType: discord.ActivityType.Playing },
		{ type: "streaming", oType: discord.ActivityType.Streaming },
		{ type: "watching", oType: discord.ActivityType.Watching }
	]

	let checkType = activityTypes.find(x => x.type == config.BOT_STATUS["Type (Listening, Watching, Playing)"].toLowerCase());
	if(checkType) currentActivity = checkType.oType;
    
    client.user.setPresence({ activities: [{ name: config.BOT_STATUS.Message.replace("{linkedPeople}", await GetTotalLinked()), type: currentActivity }], status: config.BOT_STATUS["Status (dnd, online, idle, offline)"] });
    setInterval(async () => {
        client.user.setPresence({ activities: [{ name: config.BOT_STATUS.Message.replace("{linkedPeople}", await GetTotalLinked()), type: currentActivity }], status: config.BOT_STATUS["Status (dnd, online, idle, offline)"] });
    }, 60000);
}

function GetTotalLinked() {
    return new Promise((resolve, reject) => {
        db.all("select COUNT(*) as cnt from player_info where isLinked = true;", async function(err, row) {
            resolve(row[0].cnt);
        });
    });
}

function CreateLinkingSteps() {
    config.LINKING_OPTIONS.LINKING_CHANNEL.CHANNEL_IDS.forEach(channelId => {
        db.get('select * from embed_info where channelid = ?;', [channelId], async function(err, row) {
            if(row && row != undefined) {
                const channel = client.channels.cache.get(channelId);
                if(!channel || channel == null || channel == undefined) return;
    
                channel.messages.fetch(row.embedId).then(message => { }).catch(err => {
                    db.run("delete from embed_info where channelid = ?;", [channelId]);
                    SendEmbed(channelId,  config.LINKING_OPTIONS.LINKING_CHANNEL.EMBED_OPTIONS);
                });
            } else {
                SendEmbed(channelId,  config.LINKING_OPTIONS.LINKING_CHANNEL.EMBED_OPTIONS);
            }
        });
    });
}

function SendEmbed(channelId, specialEmbed = false) {
    const channel = client.channels.cache.get(channelId);
    let embed;
    if(!channel || channel == undefined || channel == null) return;

    if(specialEmbed) {
        embed = specialEmbed;
        if(embed.color.includes("#")) embed.color = embed.color.split("#")[1];
        embed.color = Number(`0x${embed.color}`);
        embed.type = 'rich';
    } else {
        embed = new discord.EmbedBuilder();
        if(footer) embed.setFooter({ text: footer }).setTimestamp();
        if(color) embed.setColor(color);
        if(description) embed.setDescription(description);
        if(thumbnail) embed.setThumbnail(thumbnail);
        if(image) embed.setImage(image);
        if(author) embed.setAuthor(author);
    }

    channel.send({ embeds: [embed] }).then(message => { if(specialEmbed) AddEmbedinfo(message); });
}

function AddEmbedinfo(message) { db.run("insert into embed_info (embedId, channelid) values (?,?);", [message.id, message.channel.id]); }
//#endregion

//#region Crash Handlers
process.on("unhandledRejection", err => { 
    console.log(err)
});

process.on("uncaughtException", err => { 
    console.log(err)
});

process.on("uncaughtExceptionMonitor", err => { 
    console.log(err)
});
//#endregion