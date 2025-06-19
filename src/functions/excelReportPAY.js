require("dotenv").config();
const {
  getGraphClient,
  getSiteId,
  getDriveId,
  findRowIndex,
  addRowToExcel,
  updateRowInExcel,
} = require("./excelReportORDER");
require("isomorphic-fetch");
const axios = require("axios");
const querystring = require("querystring");



async function getFileId(siteId, driveId, fileName) {
    try {
      const client = await getGraphClient();
      console.log("** getFileId");
      console.log("[Excel Integration] Listing files in document library");
      
      // API call to list all files in the drive's root
      const files = await client
        .api(`/sites/${siteId}/drives/${driveId}/root/children`)
        .get();
  
      // Log all files for debugging
      console.log(
        "Files in drive:",
        files.value.map((f) => ({ name: f.name, id: f.id }))
      );
  
      // Find the file by name (case-insensitive)
      const file = files.value.find(
        (f) => f.name.toLowerCase() === fileName.toLowerCase()
      );
  
      if (!file) {
        throw new Error(`File '${fileName}' not found in document library`);
      }
  
      console.log(`Found file '${fileName}' with ID: ${file.id}`);
      return file.id;
    } catch (error) {
      console.error(`[Excel Integration] Failed to get file ID: ${error.message}`);
      throw error;
    }
  }
async function syncPaymentRequestToExcel(paymentRequest) {
  try {
    console.log("** syncPaymentRequestToExcel");
    const { PaymentRequest } = require("./db");

    console.log(
      "Starting Excel sync for payment request:",
      paymentRequest?.id_paiement || "unknown"
    );

    // Validate payment request object
    if (!paymentRequest || !paymentRequest.id_paiement) {
      console.error(
        "[Excel Integration] Invalid payment request object:",
        paymentRequest
      );
      return false;
    }

    // Check for recent sync to prevent duplicates
    if (
      paymentRequest.lastExcelSync &&
      new Date() - new Date(paymentRequest.lastExcelSync) < 10 * 1000
    ) {
      console.log(
        `[Excel Integration] Skipping sync for recently synced payment request: ${paymentRequest.id_paiement}, last synced at: ${paymentRequest.lastExcelSync}`
      );
      return true;
    }

    // Fetch the latest payment request data
    let entity = await PaymentRequest.findOne({
      id_paiement: paymentRequest.id_paiement,
    });
    if (!entity) {
      console.error(
        `[Excel Integration] Payment request not found in database: ${paymentRequest.id_paiement}`
      );
      return false;
    }

    const siteId = await getSiteId();
    const driveId = await getDriveId(siteId);
    const tableName = process.env.PAYMENT_TABLE_NAME || "PaymentRequestsTable"; // New table name for payment requests

      
    const fileName = "payments_database.xlsx"; // Replace with your new Excel file name
    const fileId = await getFileId(siteId, driveId, fileName);
      console.log(`File ID for ${fileName}: ${fileId}`);
      
     
      // Calculate payment amounts
      const totalAmount = entity.montant || 0;
      const totalAmountPaid = entity.amountPaid || 0;
      const remainingAmount = entity.remainingAmount || totalAmount - totalAmountPaid;
      const lastAmountPaid = entity.payments?.length
        ? entity.payments[entity.payments.length - 1].amountPaid || 0
        : 0;
    // Handle payment status
    let paymentStatus = "Non payé";
    if (totalAmountPaid > 0 && totalAmountPaid == totalAmount) {
      paymentStatus = "Payé";
    } else if (totalAmountPaid > 0 && totalAmountPaid < totalAmount) {
      paymentStatus = "Partiellement payé";
    }

    // // Format dates safely
    const formatDate = (date) => {
      if (!date || isNaN(new Date(date).getTime())) return "";
      return new Date(date).toISOString().split("T")[0];
    };

    const requestDate = formatDate(paymentRequest.date);
    const lastPaymentDate = paymentRequest.payments?.length
      ? formatDate(
          [...paymentRequest.payments].sort(
            (a, b) => new Date(b.dateSubmitted) - new Date(a.dateSubmitted)
          )[0].dateSubmitted
        )
      : "";

    // Format payment information
    let paymentModes = "";
    let paymentDetails = "";

    if (paymentRequest.payments?.length) {
      paymentModes = paymentRequest.payments
        .map((payment) => payment.paymentMode || "")
        .filter((mode) => mode)
        .join("\n");

      paymentDetails = paymentRequest.payments
        .map((payment) => {
          // Extract payment information
          const title = payment.paymentTitle || "";
          const amount = payment.amountPaid ? `${payment.amountPaid}` : "";
          const date = payment.dateSubmitted
            ? `(${formatDate(payment.dateSubmitted)})`
            : "";

          // Format payment details if they exist
          const details = payment.details
            ? Object.entries(payment.details)
                .map(([key, value]) => `${key}: ${value}`)
                .join(" | ")
            : "";

          // Format payment proofs with better indentation
          const proofs = payment.paymentProofs?.length
            ? `\n   📎 Proof: ${payment.paymentProofs.join("\n   📎 ")}`
            : "";

          // Format URL with an icon for better visual cue
          const url = payment.paymentUrl ? `\n   🔗 ${payment.paymentUrl}` : "";

          // Combine all elements with better spacing and organization
          const detailsLine = details ? `\n   Details: ${details}` : "";

          return `• ${title}: ${amount} ${date}${detailsLine}${proofs}${url}`;
        })
        .join("\n\n");
    }

    // Format justificatifs
    let justificatifs = paymentRequest.justificatif?.length
      ? paymentRequest.justificatif.map((doc) => `📄 ${doc.url}`).join("\n")
      : "";
    console.log("Project channel ID:", paymentRequest.project);
    console.log("Demandeur channel ID:", paymentRequest.demandeur);
    let channelName;
    if (paymentRequest.project) {
      try {
        const result = await axios.post(
          "https://slack.com/api/conversations.info",
          querystring.stringify({ channel: paymentRequest.project }),
          {
            headers: {
              Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
              "Content-Type": "application/x-www-form-urlencoded",
            },
          }
        );
        if (result.data.ok) channelName = result.data.channel.name;
      } catch (error) {
        console.log(`Failed to get channel name: ${error.message}`);
      }
    }
    let demandeur = "";
    if (paymentRequest.demandeur) {
      try {
        const result = await axios.post(
          "https://slack.com/api/users.info",
          querystring.stringify({ user: paymentRequest.demandeurId }), // Use 'user' instead of 'channel'
          {
            headers: {
              Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
              "Content-Type": "application/x-www-form-urlencoded",
            },
          }
        );
        if (result.data.ok) {
          demandeur = result.data.user.name || result.data.user.real_name || "";
          console.log(`Assigned demandeur: ${demandeur}`);
        } else {
          console.error(`Slack API error for demandeur: ${result.data.error}`);
        }
      } catch (error) {
        console.error(`Failed to get demandeur user name: ${error.message}`);
      }
    }

    // Construct row data for payment request
    const rowData = [
      paymentRequest.id_paiement || "",
      paymentRequest.titre || "",
      paymentRequest.statut || "En attente",
      demandeur || "",
      paymentRequest.project || "", // Channel/project
      new Date(paymentRequest.date).toLocaleString("fr-FR", {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        timeZoneName: "short",
      }),

      new Date(paymentRequest.date_requete).toLocaleString("fr-FR", {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
      }) || "",
      paymentRequest.motif || "",
      paymentRequest.bon_de_commande || "",
      justificatifs,
      totalAmount.toString(),
      totalAmountPaid.toString(),
      lastAmountPaid.toString(),
      remainingAmount.toString(),
      // paymentRequest.devise || "XOF",
      // paymentModes,
      // paymentDetails,
      

      paymentStatus,
      paymentRequest.payments
          ? paymentRequest.payments
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
                return `• ${title}: ${amount} ${paymentRequest.devise} ${date} ${paymentModes} ${detailsLine}${proofs}${url}`;
              })
              .join("\n\n")
          : '',
      // lastPaymentDate,
      paymentRequest.rejection_reason || "",
    ];

    const rowIndex = await findRowIndex(
      siteId,
      driveId,
      fileId,
      tableName,
      paymentRequest.id_paiement
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
          `[Excel Integration] Skipping update for unchanged row: ${paymentRequest.id_paiement}`
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
    await PaymentRequest.updateOne(
      { id_paiement: paymentRequest.id_paiement },
      { lastExcelSync: new Date() }
    );

    console.log(
      "Excel sync completed for payment request:",
      paymentRequest.id_paiement
    );
    return true;
  } catch (error) {
    console.error(
      `Failed to sync payment request to Excel: ${error.message}`,
      error.stack
    );
    return false;
  }
}

// Export the new function
module.exports = { syncPaymentRequestToExcel,getFileId };
