
require("dotenv").config();
const { Client } = require("@microsoft/microsoft-graph-client");
const { DefaultAzureCredential } = require("@azure/identity");
require("isomorphic-fetch");

async function getGraphClient() {
  try {
    console.log("** getGraphClient");
    const requiredEnvVars = [
      "AZURE_TENANT_ID",
      "AZURE_CLIENT_ID",
      "AZURE_CLIENT_SECRET",
      "SHAREPOINT_HOSTNAME",
      "EXCEL_TABLE_NAME",
    ];
    const missingVars = requiredEnvVars.filter(
      (varName) => !process.env[varName]
    );
    if (missingVars.length > 0) {
      throw new Error(
        `Missing required environment variables: ${missingVars.join(", ")}`
      );
    }
    console.log("Environment variables:", {
      tenantId: process.env.AZURE_TENANT_ID,
      clientId: process.env.AZURE_CLIENT_ID,
      clientSecret: process.env.AZURE_CLIENT_SECRET
        ? "[REDACTED]"
        : "undefined",
      sharepointHostname: process.env.SHAREPOINT_HOSTNAME,
      excelTableName: process.env.EXCEL_TABLE_NAME,
    });

    console.log("[Excel Integration] Initializing DefaultAzureCredential");
    const credential = new DefaultAzureCredential();
    console.log("[Excel Integration] Requesting Graph API token");
    const token = await credential.getToken(
      "https://graph.microsoft.com/.default"
    );
    console.log("[Excel Integration] Token obtained successfully", {
      scope: token.scope,
    });

    return Client.init({
      authProvider: (done) => {
        done(null, token.token);
      },
    });
  } catch (error) {
    console.error(
      `[Excel Integration] Graph API authentication failed: ${error.message}`
    );
    console.error(error.stack);
    throw error;
  }
}

async function getSiteId() {
  try {
    console.log("** getSiteId");
    const client = await getGraphClient();
    console.log("[Excel Integration] Making API call to get site");
    const site = await client
      .api("/sites/espaceprojets.sharepoint.com:/sites/OrderAppDB")
      .get();
    console.log("[Excel Integration] Site ID retrieved:", site.id);
    return site.id;
  } catch (error) {
    console.error("[Excel Integration] Failed to get Site ID:", error.message);
    console.error("[Excel Integration] HTTP Status Code:", error.statusCode);
    console.error(
      "[Excel Integration] Error Response Body:",
      JSON.stringify(error.body, null, 2)
    );
    throw error;
  }
}

async function getDriveId(siteId) {
  try {
    console.log("** getDriveId");
    const client = await getGraphClient();
    const drives = await client.api(`/sites/${siteId}/drives`).get();
    console.log(
      "Available drives:",
      drives.value.map((d) => ({ id: d.id, name: d.name }))
    );
    const drive = drives.value.find(
      (d) =>
        d.name === "Documents partagés" ||
        d.name === "Shared Documents" ||
        d.name === "Documents"
    );
    if (!drive) {
      throw new Error(
        "No document library found (tried 'Documents partagés', 'Shared Documents', 'Documents')"
      );
    }
    console.log("Drive ID:", drive.id);
    return drive.id;
  } catch (error) {
    console.error(`Failed to get Drive ID: ${error.message}`);
    throw error;
  }
}

async function addRowToExcel(siteId, driveId, fileId, tableName, rowValues) {
  try {
    console.log("** addRowToExcel");
    const client = await getGraphClient();
    
    await client
      .api(
        `/sites/${siteId}/drives/${driveId}/items/${fileId}/workbook/tables('${tableName}')/rows/add`
      )
      .post({
        values: [rowValues],
      });
    console.log("✅ Row added successfully to the table:", tableName);
  } catch (error) {
    console.error("❌ Failed to add row:", error.message);
    throw error;
  }
}

async function findRowIndex(
  siteId,
  driveId,
  fileId,
  tableName,
  idCommande,
  retries = 3,
  delay = 1000
) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      console.log("** findRowIndex");
      const client = await getGraphClient();
      console.log(
        `[Excel Integration] Fetching rows from table: ${tableName} (Attempt ${attempt})`
      );
      const rows = await client
        .api(
          `/sites/${siteId}/drives/${driveId}/items/${fileId}/workbook/tables('${tableName}')/rows`
        )
        .get();

      console.log(
        `[Excel Integration] Found ${rows.value.length} rows in table`
      );

      const rowIndex = rows.value.findIndex(
        (row) => row.values[0][0] === idCommande
      );

      if (rowIndex === -1) {
        console.log(
          `[Excel Integration] No row found for order: ${idCommande}`
        );
        if (attempt < retries) {
          console.log(`[Excel Integration] Retrying after ${delay}ms...`);
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }
        return null;
      }

      console.log(
        `[Excel Integration] Found row at index ${rowIndex} for order: ${idCommande}`
      );
      return rowIndex;
    } catch (error) {
      console.error(
        `[Excel Integration] Failed to find row (Attempt ${attempt}): ${error.message}`
      );
      if (attempt < retries) {
        console.log(`[Excel Integration] Retrying after ${delay}ms...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
      throw error;
    }
  }
}

async function updateRowInExcel(
  siteId,
  driveId,
  fileId,
  tableName,
  rowIndex,
  rowValues
) {
  try {
    console.log("** updateRowInExcel");
    const client = await getGraphClient();
    console.log(
      `[Excel Integration] Updating row at index ${rowIndex} in table: ${tableName}`
    );
  //  console.log("rowValues1", rowValues);
    await client
      .api(
        `/sites/${siteId}/drives/${driveId}/items/${fileId}/workbook/tables('${tableName}')/rows/itemAt(index=${rowIndex})`
      )
      .patch({
        values: [rowValues],
      });
    console.log(
      `✅ Row updated successfully at index ${rowIndex} in table: ${tableName}`
    );
  } catch (error) {
    console.error(`[Excel Integration] Failed to update row: ${error.message}`);
    throw error;
  }
}


async function syncOrderToExcel(order) {
  try {
    console.log("** syncOrderToExcel");
    const { Order } = require("./db");

    console.log("Starting Excel sync for order:", order?.id_commande || "unknown");

    // Validate order object
    if (!order || !order.id_commande) {
      console.error("[Excel Integration] Invalid order object:", order);
      return false;
    }

    // Check for recent sync to prevent duplicates
    if (
      order.lastExcelSync &&
      new Date() - new Date(order.lastExcelSync) < 30 * 1000
    ) {
      console.log(
        `[Excel Integration] Skipping sync for recently synced order: ${order.id_commande}, last synced at: ${order.lastExcelSync}`
      );
      return true;
    }

    // Fetch the latest order data
    let entity = await Order.findOne({ id_commande: order.id_commande });
    if (!entity) {
      console.error(
        `[Excel Integration] Order not found in database: ${order.id_commande}`
      );
      return false;
    }

    const siteId = await getSiteId();
    const driveId = await getDriveId(siteId);
    const fileId = "6AD4369C-C1C5-46E3-873B-AECC71234DDF";
    const tableName = process.env.EXCEL_TABLE_NAME || "OrdersTable";
    

    // Get latest validated proforma
    const validatedProforma = entity.proformas?.find((p) => p.validated) || null;

    // Calculate payment amounts
    const totalAmount = validatedProforma?.montant || 0; // Use montant_total
    const totalAmountPaid = entity.payments?.reduce(
      (sum, payment) => sum + (payment.amountPaid || 0),
      0
    ) || 0; // Sum of all payments
    const lastPaymentAmount = entity.payments?.length
      ? entity.payments[entity.payments.length - 1].amountPaid || 0
      : 0; // Last payment amount
    const remainingAmount = totalAmount - totalAmountPaid;

    console.log("totalAmount:", totalAmount);
    console.log("lastPaymentAmount:", lastPaymentAmount);
    console.log("totalAmountPaid:", totalAmountPaid);
    console.log("remainingAmount:", remainingAmount);
    console.log("entity.paymentDone:", entity.paymentDone);
    // Handle payment status
    let paymentStatus = "Non payé";
    if (totalAmount === 0) {
      paymentStatus = "Non Payé";
    }else
    if (entity.paymentDone=="true" || totalAmountPaid >= totalAmount) {
      paymentStatus = "Payé";
      console.log("Set to Payé");
    } else if (totalAmountPaid > 0 && totalAmountPaid < totalAmount) {
      paymentStatus = "Partiellement payé";
      console.log("Set to Partiellement payé");
    }
    console.log("Final paymentStatus:", paymentStatus);
    console.log("entity.paymentDone:", entity.paymentDone);

    console.log("Condition (entity.paymentDone || totalAmountPaid >= totalAmount):", entity.paymentDone || totalAmountPaid >= totalAmount);
    console.log("typeof totalAmount:", typeof totalAmount);
console.log("typeof totalAmountPaid:", typeof totalAmountPaid);
    console.log("paymentStatus:", paymentStatus);
    // Format dates safely
    const formatDate = (date) => {
      if (!date || isNaN(new Date(date).getTime())) return "";
      return new Date(date).toISOString().split("T")[0];
    };

    const orderDate = formatDate(entity.date);
    const lastPaymentDate = entity.payments?.length
      ? formatDate(
          [...entity.payments].sort(
            (a, b) => new Date(b.dateSubmitted) - new Date(a.dateSubmitted)
          )[0].dateSubmitted
        )
      : "";
    const validatedAt = validatedProforma
      ? formatDate(validatedProforma.validatedAt)
      : "";

    // Format article information
    let articleDesignation = entity.articles?.length
      ? entity.articles
      .map((a) => `${a.quantity} ${a.unit || ''} ${a.designation}`)
      .join('; ')
      : "";
// Prepare article data with photos
            const articlesWithPhotos = order.articles.map((article, index) => {
                const articleNumber = index + 1;
                let photoLinks = "";
                
                if (article.photos && article.photos.length > 0) {
                    photoLinks = article.photos
                        .map((photo, photoIndex) => `- Photo ${photoIndex + 1}: ${photo.permalink || photo.url}`)
                        .join(" | ");
                }

                return {
                    articleNumber,
                    designation: article.designation || 'Article sans nom',
                    quantity: article.quantity || 1,
                    unit: article.unit || 'unité(s)',
                    reference: article.reference || '',
                    brand: article.brand || '',
                    category: article.category || '',
                    description: article.description || '',
                    price: article.price || '',
                    currency: article.currency || 'XOF',
                    supplier: article.supplier || '',
                    photoLinks: photoLinks,
                    photoCount: article.photos ? article.photos.length : 0
                };
            });
            // Create a comprehensive articles string with photos
            const articlesString = articlesWithPhotos.map(article => {
                let articleText = `${article.articleNumber}. ${article.designation} ${article.quantity} ${article.unit} `;

                if (article.photoCount > 0) {
                    articleText += `\n  • Photos (${article.photoCount}): ${article.photoLinks}`;
                }
                
                return articleText;
            }).join('\n\n---\n\n');

    // Format payment information
    let paymentModes = "";
    let paymentDetails = "";
    let paymentUrl = "";
    if (entity.payments?.length) {
      paymentModes = entity.payments
        .map((payment) => payment.paymentMode || "")
        .filter((mode) => mode)
        .join("\n");

      paymentDetails = entity.payments
        .map((payment) => {
          const title = payment.paymentTitle || "";
          const amount = payment.amountPaid ? `${payment.amountPaid}` : "";
          const date = payment.dateSubmitted
            ? `(${formatDate(payment.dateSubmitted)})`
            : "";
          const details = payment.details
            ? Object.entries(payment.details)
                .map(([key, value]) => `${key}: ${value}`)
                .join(" | ")
            : "";
          const proofs = payment.paymentProofs?.length
            ? `\n   📎 Proof: ${payment.paymentProofs.join("\n   📎 ")}`
            : "";
          const url = payment.paymentUrl
            ? `\n   🔗 ${payment.paymentUrl}`
            : "";
          const detailsLine = details ? `\n   Details: ${details}` : "";
          return `• ${title}: ${amount} ${date}${detailsLine}${proofs}${url}`;
        })
        .join("\n\n");
      paymentUrl = entity.payments
        .map((payment) => payment.paymentUrl)
        .filter((url) => url)
        .join("\n");
    }

    let status = entity.autorisation_admin === "Oui" ? "Valide" : "Non Valide";

    // Construct row data
    const rowData = [
      entity.id_commande || "",
      entity.titre || "",
      entity.statut || "En attente",
      entity.demandeur || "",
      entity.channel || "",
      entity.equipe || "Non spécifié",
      new Date(entity.date).toLocaleString("fr-FR", {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        timeZoneName: "short",
      }),
      new Date(entity.date_requete).toLocaleString("fr-FR", {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
      }) || "",

      // entity.autorisation_admin ? "Oui" : "Non",

      articlesString,
      
      totalAmount.toString(),
      totalAmountPaid.toString(),
      lastPaymentAmount.toString(),
      remainingAmount.toString(),

      // validatedProforma?.devise || "USD", // Use USD based on logs
      paymentStatus,
      // validatedProforma ? "Oui" : "Non",
      // validatedProforma?.fournisseur || "",
      // validatedProforma?.urls?.join("\n\n") || "",

      validatedProforma
        ? `${validatedProforma.nom}: ${validatedProforma.montant} ${validatedProforma.devise} ${validatedProforma.urls?.join("\n\n") || ''}`
              : '',
      entity.validatedBy || "",
      validatedAt,

      // paymentModes,
      // paymentDetails,
      // lastPaymentDate,
      
      entity.payments
          ? entity.payments
              .map((payment) => {
                const title = payment.paymentTitle || "";
                const amount = payment.amountPaid ? `${payment.amountPaid}` : "";
                const date = payment.dateSubmitted
                  ? `${formatDate(payment.dateSubmitted)}`
                  : "";
                const paymentModes =  payment.paymentMode || "";
                const details = payment.details
                  ? Object.entries(payment.details)
                      .map(([key, value]) => `${key}: ${value}`)
                      .join(" | ")
                  : "";
                const proofs = payment.paymentProofs?.length
                  ? `\n   📎 Proof: ${payment.paymentProofs.join("\n   📎 ")}`
                  : "";
                const url = payment.paymentUrl
                  ? `\n   🔗 ${payment.paymentUrl}`
                  : "";
                const detailsLine = details ? `\n   Details: ${details}` : "";
                return `• ${title}: ${amount} ${date} ${paymentModes} ${detailsLine}${proofs}${url}`;
              })
              .join("\n\n")
          : '',
      entity.deleted ? "Oui" : "Non",
      formatDate(entity.deletedAt),
      entity.deletedByName || "",
      entity.rejection_reason || entity.deletionReason || "",
    ];

    const rowIndex = await findRowIndex(
      siteId,
      driveId,
      fileId,
      tableName,
      entity.id_commande
    );

    if (rowIndex !== null) {
      const client = await getGraphClient();
      const rows = await client
        .api(
          `/sites/${siteId}/drives/${driveId}/items/${fileId}/workbook/tables('${tableName}')/rows`
        )
        .get();
      const currentRow = rows.value[rowIndex];
      if (JSON.stringify(currentRow.values[0]) === JSON.stringify(rowData)) {
        console.log(
          `[Excel Integration] Skipping update for unchanged row: ${entity.id_commande}`
        );
        return true;
      }
      await updateRowInExcel(
        siteId,
        driveId,
        fileId,
        tableName,
        rowIndex,
        rowData
      );
    } else {
      await addRowToExcel(siteId, driveId, fileId, tableName, rowData);
    }

    // Update lastExcelSync timestamp
    await Order.updateOne(
      { id_commande: entity.id_commande },
      { lastExcelSync: new Date() }
    );

    console.log("Excel sync completed for order:", entity.id_commande);
    return true;
  } catch (error) {
    console.error(
      `Failed to sync order to Excel: ${error.message}`,
      error.stack
    );
    return false;
  }
}

async function verifyFile(siteId, driveId, fileId) {
  try {
    console.log("** verifyFile");
    const client = await getGraphClient();
    const file = await client
      .api(`/sites/${siteId}/drives/${driveId}/items/${fileId}`)
      .get();
    console.log("File Name:", file.name);
    return file;
  } catch (error) {
    console.error(`Failed to verify file: ${error.message}`);
    throw error;
  }
}

module.exports = { syncOrderToExcel,addRowToExcel, verifyFile ,getGraphClient,getSiteId ,getDriveId, findRowIndex,updateRowInExcel };
