const { SlashCommandBuilder } = require("@discordjs/builders");
const discord = require('discord.js');
const config = require('../../config.json');
module.exports = {
  data: new SlashCommandBuilder()
    .setName("unlink")
    .setDescription("Unlink your account"),
    run: async (client, interaction) => {
        if(config.LINKING_OPTIONS.FANCY_REPLIES) {
            const embed = new discord.EmbedBuilder()
            .setColor(config.DEFAULT_EMBED_COLOR)
            .setDescription(config.LANG_MESSGAES.UnlinkingMsg);

            interaction.reply({ embeds: [embed], ephemeral: true });
        }
    }
 };
