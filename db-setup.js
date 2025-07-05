// db-setup.js - Database initialization and migration
const mongoose = require("mongoose");
const { Config, UserRole } = require("./db");

// Default configuration values
const DEFAULT_CONFIG = {
	equipe_options: ["Maçons", "Carreleur", "Peintre", "Coffreur"],
	unit_options: [
		"pièce",
		"m²",
		"kg",
		"Pots",
		"Rouleaux",
		"Sac",
		"Bottes",
		"Cartons",
		"Tonnes",
	],
	currencies: ["EUR", "USD", "XOF"],
	fournisseur_options: [
        "ABDOUSSALAMI RAHIOU",
        "AFRICAWORK COTE D'IVOIRE",
        "AGA GROUP OF COMPANY",
        "AGAF GROUP SARL",
        "AGENCE ORANGE SAHA",
        "Aicha communication",
        "Air France",
        "Autodesk, Inc.",
        "BAOBAB PLUS Côte d'Ivoire",
        "BERNABE COTE D IVORIE S.A.",
        "BO Quincaillerie",
        "BUILD Tout Pour Le Bâtiment",
        "CFAO",
        "CIDMAC-CI",
        "COMPAGNIE IVOIRIENNE DE COMMERCE ET DE BATIMENT",
        "Cake.com AG",
        "China Mall Côte D'Ivoire",
        "Distribution Inter Service",
        "Drocolor",
        "ETS AZIZ LATIF",
        "ETS RABIU",
        "ETS VISION",
        "FER IVOIRE SARL U",
        "Fond d'entretien routier (FER)",
        "G-BATE",
        "HA HALIF ALHASSAN",
        "Hyper Hayat",
        "INGECO SARL",
        "ISSA RADJIKOU",
        "ISSOUF ABDOUL MALICK",
        "Autre"
    ],
};

// Initialize default configuration in database
async function initializeDefaultConfig() {
	try {
		console.log("🔧 Initializing default configuration...");

		for (const [key, values] of Object.entries(DEFAULT_CONFIG)) {
			const existingConfig = await Config.findOne({ key });

			if (!existingConfig) {
				await Config.create({ key, values });
				console.log(`✅ Created default config for ${key}:`, values);
			} else {
				console.log(`ℹ️ Config for ${key} already exists, skipping.`);
			}
		}

		console.log("✅ Default configuration initialized successfully");
	} catch (error) {
		console.error("❌ Error initializing default config:", error);
		throw error;
	}
}

// Backup current configuration
async function backupConfiguration() {
	try {
		const configs = await Config.find({});
		const users = await UserRole.find({});

		const backup = {
			timestamp: new Date().toISOString(),
			configs: configs.reduce((acc, config) => {
				acc[config.key] = config.values;
				return acc;
			}, {}),
			users: users.map((user) => ({
				userId: user.userId,
				roles: user.roles,
			})),
		};

		console.log(
			"📋 Current configuration backup:",
			JSON.stringify(backup, null, 2)
		);
		return backup;
	} catch (error) {
		console.error("❌ Error creating backup:", error);
		throw error;
	}
}

// Restore configuration from backup
async function restoreConfiguration(backup) {
	try {
		console.log("🔄 Restoring configuration from backup...");

		// Restore configs
		for (const [key, values] of Object.entries(backup.configs)) {
			await Config.findOneAndUpdate({ key }, { values }, { upsert: true });
			console.log(`✅ Restored config for ${key}`);
		}

		// Restore user roles
		for (const userData of backup.users) {
			await UserRole.findOneAndUpdate(
				{ userId: userData.userId },
				{ roles: userData.roles },
				{ upsert: true }
			);
			console.log(`✅ Restored roles for user ${userData.userId}`);
		}

		console.log("✅ Configuration restored successfully");
	} catch (error) {
		console.error("❌ Error restoring configuration:", error);
		throw error;
	}
}

// Validate configuration integrity
async function validateConfiguration() {
	try {
		console.log("🔍 Validating configuration...");

		const requiredConfigs = ["equipe_options", "unit_options", "currencies", "fournisseur_options"];
		const issues = [];

		for (const configKey of requiredConfigs) {
			const config = await Config.findOne({ key: configKey });

			if (!config) {
				issues.push(`Missing configuration: ${configKey}`);
			} else if (!config.values || config.values.length === 0) {
				issues.push(`Empty configuration: ${configKey}`);
			}
		}

		// Check for admin users
		const adminUsers = await UserRole.find({ roles: "admin" });
		if (adminUsers.length === 0) {
			issues.push("No admin users found in the system");
		}

		if (issues.length > 0) {
			console.log("⚠️ Configuration issues found:");
			issues.forEach((issue) => console.log(`  - ${issue}`));
			return false;
		}

		console.log("✅ Configuration validation passed");
		return true;
	} catch (error) {
		console.error("❌ Error validating configuration:", error);
		return false;
	}
}

// ...existing code...

// Create initial admin user if provided
async function createInitialAdmin(userId, username) {
	if (!userId) {
		console.log(
			"ℹ️ No initial admin user ID provided, skipping admin creation."
		);
		return;
	}

	try {
		const existingUser = await UserRole.findOne({ userId });

		if (!existingUser) {
			await UserRole.create({
				userId,
				username: username || null,
				roles: ["admin"],
			});
			console.log(
				`✅ Created initial admin user: ${username || userId} (${userId})`
			);
		} else {
			// Update username if provided and different
			if (username && existingUser.username !== username) {
				existingUser.username = username;
			}

			if (!existingUser.roles.includes("admin")) {
				existingUser.roles.push("admin");
				await existingUser.save();
				console.log(
					`✅ Added admin role to existing user: ${
						username || userId
					} (${userId})`
				);
			} else {
				console.log(
					`ℹ️ User ${username || userId} (${userId}) already has admin role.`
				);
			}
		}
	} catch (error) {
		console.error("❌ Error creating initial admin:", error);
		throw error;
	}
}

// Migration script to move from hardcoded values to database
async function migrateToDatabase(
	initialAdminId = null,
	initialAdminUsername = null
) {
	try {
		console.log("🚀 Starting database migration...");

		// Connect to MongoDB if not already connected
		if (mongoose.connection.readyState === 0) {
			await mongoose.connect(process.env.MONGODB_URI, {
				useNewUrlParser: true,
				useUnifiedTopology: true,
			});
			console.log("✅ Connected to MongoDB");
		}

		// Initialize default configuration
		await initializeDefaultConfig();

		// Create initial admin if provided
		if (initialAdminId) {
			await createInitialAdmin(initialAdminId, initialAdminUsername);
		}

		console.log("🎉 Migration completed successfully!");
	} catch (error) {
		console.error("❌ Migration failed:", error);
		throw error;
	}
}

// ...existing code...

// CLI interface for running migrations
async function runMigration() {
	const args = process.argv.slice(2);
	const command = args[0];

	switch (command) {
		case "init":
			const adminId = args[1];
			const adminUsername = args[2];

			if (!adminId) {
				console.error(
					"❌ Please provide admin user ID: node db-setup.js init <userId> [username]"
				);
				console.error(
					'Example: node db-setup.js init U08F8FT3U85 "souhir oualha"'
				);
				process.exit(1);
			}

			await migrateToDatabase(adminId, adminUsername);
			break;

		// ...existing code...

		default:
			console.log(`
🛠️ Database Migration Tool

Usage: node db-setup.js <command> [options]

Commands:
  init <adminUserId> [username]  - Initialize database with default config and admin user
  backup                        - Create a backup of current configuration
  validate                      - Validate configuration integrity
  restore <file>               - Restore configuration from backup file

Examples:
  node db-setup.js init U08F8FT3U85 "souhir oualha"
  node db-setup.js init U01234567890
  node db-setup.js backup > backup.json
  node db-setup.js validate
  node db-setup.js restore backup.json
      `);
			break;
	}

	// Close database connection
	if (mongoose.connection.readyState === 1) {
		await mongoose.disconnect();
		console.log("✅ Database connection closed");
	}
}

// Export functions for use in other modules
module.exports = {
	initializeDefaultConfig,
	createInitialAdmin,
	migrateToDatabase,
	backupConfiguration,
	restoreConfiguration,
	validateConfiguration,
	DEFAULT_CONFIG,
};

// Run CLI if this file is executed directly
if (require.main === module) {
	runMigration().catch((error) => {
		console.error("❌ Migration failed:", error);
		process.exit(1);
	});
}
