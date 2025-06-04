const { SlashCommandBuilder } = require("@discordjs/builders");
module.exports = {
  data: new SlashCommandBuilder()
    .setName("force-update-data")
    .setDescription("Force updates all linked users data"),
    run: async (client, interaction) => {

    }
 };
