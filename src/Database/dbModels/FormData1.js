const mongoose = require("mongoose");

// Define a schema for temporary form data
const FormDataSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  data: { type: Object, required: true },
  createdAt: { type: Date, default: Date.now, expires: "1h" }, // Auto-expire after 1 hour
});

const FormData1 = mongoose.model("FormData1", FormDataSchema);

module.exports = FormData1;