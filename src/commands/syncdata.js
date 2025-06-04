const { SlashCommandBuilder } = require("@discordjs/builders");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("sync-link")
    .setDescription("Sync data from other plugins")
    .addStringOption(option =>
		option.setName('data-type')
			.setDescription('What plugin')
			.setRequired(true)
			.addChoices(
				{ name: 'Steamcord', value: 'steamcord' },
				{ name: 'Discord Core', value: 'discordcore' },
				{ name: 'Discord Auth', value: 'discordauth' },
				{ name: 'Discord Link V1', value: 'discordlink' },
			))
    .addAttachmentOption(Option => Option.setName('links-file').setDescription("Please provide your datafile").setRequired(true)),
    run: async (client, interaction) => {

    }
 };
