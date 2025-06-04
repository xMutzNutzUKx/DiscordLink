const { SlashCommandBuilder } = require("@discordjs/builders");
module.exports = {
  data: new SlashCommandBuilder()
    .setName("search-link")
    .setDescription("Search for a linked user")
    .addStringOption(Option => Option.setName('steam-64-id').setDescription("Your steam 64ID starts with 765611").setRequired(false))
    .addUserOption(Option => Option.setName('user').setDescription("Select the user you want to search").setRequired(false)),
    run: async (client, interaction) => {

    }
 };
