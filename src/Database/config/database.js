const mongoose = require("mongoose");
require("dotenv").config();

const MONGODB_URI = process.env.MONGODB_URI;

if (!MONGODB_URI?.match(/^mongodb(\+srv)?:\/\//)) {
  throw new Error(
    "Format MongoDB URI invalide. Doit commencer par mongodb:// ou mongodb+srv://"
  );
}


mongoose.set("debug", true);
mongoose
  .connect(MONGODB_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  })
  .then(() => {
    console.log("MongoDB connected successfully");
  })
  .catch((err) => {
    console.error("MongoDB connection error:", err);
  });
