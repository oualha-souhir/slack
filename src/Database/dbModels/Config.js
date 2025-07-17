const mongoose = require("mongoose");

const ConfigSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true }, // 'equipe_options', 'unit_options', 'currencies'
  values: { type: [String], default: [] },
});

const Config = mongoose.model("Config", ConfigSchema);
module.exports = Config;