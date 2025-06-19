// config.js - Database configuration helpers
const { Config } = require("./db");

// Helper function to get config values from database
async function getConfigValues(key, defaultValues = []) {
  try {
    const config = await Config.findOne({ key });
    return config ? config.values : defaultValues;
  } catch (error) {
    console.error(`Error fetching config for ${key}:`, error);
    return defaultValues;
  }
}
async function getFournisseurOptions() {
  try {
    const values = await getConfigValues("fournisseur_options", ["Fournisseur Ab", "Fournisseur Bv", "Fournisseur dC"]);
    return values.map(value => ({
      text: { type: "plain_text", text: value },
      value: value.toLowerCase().replace(/\s+/g, "_")
    }));
  } catch (error) {
    console.error("Error in getFournisseurOptions:", error);
    // Return default options if there's an error
    return [
      { text: { type: "plain_text", text: "Fournisseur Aa" }, value: "fournisseur_aA" },
      { text: { type: "plain_text", text: "Fournisseur Bb" }, value: "fournisseur_bB" },
      { text: { type: "plain_text", text: "Fournisseur Cc" }, value: "fournisseur_cC" },
      { text: { type: "plain_text", text: "Autre" }, value: "autre" }
    ];
  }
}
// Helper function to update config values in database
async function updateConfigValues(key, values) {
  try {
    return await Config.findOneAndUpdate(
      { key },
      { values },
      { upsert: true, new: true }
    );
  } catch (error) {
    console.error(`Error updating config for ${key}:`, error);
    throw error;
  }
}

// Helper function to add a single value to config
async function addConfigValue(key, value) {
  try {
    return await Config.findOneAndUpdate(
      { key },
      { $addToSet: { values: value } },
      { upsert: true, new: true }
    );
  } catch (error) {
    console.error(`Error adding config value for ${key}:`, error);
    throw error;
  }
}

// Helper function to remove a single value from config
async function removeConfigValue(key, value) {
  try {
    return await Config.findOneAndUpdate(
      { key },
      { $pull: { values: value } },
      { new: true }
    );
  } catch (error) {
    console.error(`Error removing config value for ${key}:`, error);
    throw error;
  }
}

// Get formatted options for Slack Select elements
async function getEquipeOptions() {
  const values = await getConfigValues("equipe_options", ["IT", "Finance", "Achat", "RH"]);
  return values.map(value => ({
    text: { type: "plain_text", text: value },
    value: value.toLowerCase().replace(/\s+/g, "_")
  }));
}

async function getUnitOptions() {
  const values = await getConfigValues("unit_options", ["pièce", "kg", "litre", "mètre"]);
  return values.map(value => ({
    text: { type: "plain_text", text: value },
    value: value.toLowerCase().replace(/\s+/g, "_")
  }));
}

async function getCurrencies() {
  const values = await getConfigValues("currencies", ["TND", "EUR", "USD"]);
  return values.map(value => ({
    text: { type: "plain_text", text: value },
    value: value
  }));
}
// // Configuration Modal Generator
// function generateConfigModal(equipeOptions, unitOptions, currencies) {
//   return {
//     type: "modal",
//     callback_id: "config_modal",
//     title: { type: "plain_text", text: "Configuration Système" },
//     submit: { type: "plain_text", text: "Fermer" },
//     blocks: [
//       {
//         type: "section",
//         text: {
//           type: "mrkdwn",
//           text: "*🛠️ Configuration du Système*\nGérez les options disponibles dans le système."
//         }
//       },
//       { type: "divider" },
//       {
//         type: "section",
//         text: {
//           type: "mrkdwn",
//           text: `*👥 Équipes disponibles:*\n${equipeOptions.length > 0 ? equipeOptions.join(", ") : "Aucune équipe configurée"}`
//         },
//         accessory: {
//           type: "button",
//           action_id: "manage_equipes",
//           text: { type: "plain_text", text: "Gérer" },
//           value: "manage_equipes"
//         }
//       },
//       {
//         type: "section",
//         text: {
//           type: "mrkdwn",
//           text: `*📏 Unités disponibles:*\n${unitOptions.length > 0 ? unitOptions.join(", ") : "Aucune unité configurée"}`
//         },
//         accessory: {
//           type: "button",
//           action_id: "manage_units",
//           text: { type: "plain_text", text: "Gérer" },
//           value: "manage_units"
//         }
//       },
//       {
//         type: "section",
//         text: {
//           type: "mrkdwn",
//           text: `*💰 Devises disponibles:*\n${currencies.length > 0 ? currencies.join(", ") : "Aucune devise configurée"}`
//         },
//         accessory: {
//           type: "button",
//           action_id: "manage_currencies",
//           text: { type: "plain_text", text: "Gérer" },
//           value: "manage_currencies"
//         }
//       },
//       { type: "divider" },
//       {
//         type: "section",
//         text: {
//           type: "mrkdwn",
//           text: "*🔧 Commandes disponibles:*\n• `/order config` - Ouvrir ce panneau\n• `/order addrole @user role` - Ajouter un rôle\n• `/order removerole @user role` - Retirer un rôle\n• `/order add equipe NomEquipe` - Ajouter une équipe\n• `/order add unit NomUnité` - Ajouter une unité\n• `/order add currency CODE` - Ajouter une devise"
//         }
//       }
//     ]
//   };
// }

// Management Modal Generator
// function generateManagementModal(type, items, title) {
//   const blocks = [
//     {
//       type: "section",
//       text: {
//         type: "mrkdwn",
//         text: `*${title}*`
//       }
//     },
//     { type: "divider" }
//   ];

//   if (items.length === 0) {
//     blocks.push({
//       type: "section",
//       text: {
//         type: "mrkdwn",
//         text: `Aucun élément configuré. Utilisez la commande \`/order add ${type} <valeur>\` pour ajouter des éléments.`
//       }
//     });
//   } else {
//     items.forEach((item, index) => {
//       blocks.push({
//         type: "section",
//         text: {
//           type: "mrkdwn",
//           text: `• ${item}`
//         },
//         accessory: {
//           type: "button",
//           action_id: `remove_${type}_${index}`,
//           text: { type: "plain_text", text: "Supprimer" },
//           value: `${type}:${item}`,
//           style: "danger"
//         }
//       });
//     });
//   }

//   blocks.push(
//     { type: "divider" },
//     {
//       type: "input",
//       block_id: `add_${type}_input`,
//       label: { type: "plain_text", text: `Ajouter un nouvel élément` },
//       element: {
//         type: "plain_text_input",
//         action_id: `input_new_${type}`,
//         placeholder: { type: "plain_text", text: `Entrez le nouveau ${type}` }
//       }
//     },
//     {
//       type: "actions",
//       elements: [
//         {
//           type: "button",
//           action_id: `add_${type}_button`,
//           text: { type: "plain_text", text: "Ajouter" },
//           value: `add_${type}`,
//           style: "primary"
//         }
//       ]
//     }
//   );

//   return {
//     type: "modal",
//     callback_id: `manage_${type}_modal`,
//     title: { type: "plain_text", text: title },
//     submit: { type: "plain_text", text: "Fermer" },
//     blocks
//   };
// }
module.exports = {
  getConfigValues,
  updateConfigValues,
  addConfigValue,
  removeConfigValue,
  getEquipeOptions,
  getUnitOptions,
  getCurrencies,getFournisseurOptions
  // generateConfigModal,
  // generateManagementModal
};
