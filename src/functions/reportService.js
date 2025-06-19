
// src/reportService.js
const { Order } = require("./db");
const { postSlackMessage } = require("./utils");
const { OpenAI } = require("openai");

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
let isScheduledR = false;

// Generate payment and order report
async function  generateReport(context) {
  console.log("** generateReport");
  const orders = await Order.find({}).sort({ date: -1 }).limit(100);
  const totalOrders = orders.length;
  
  // Calculate total paid by currency
  const totalPaidByCurrency = orders.reduce((acc, o) => {
    o.proformas.forEach(p => {
      const currency = p.devise || "XOF"; // Default to XOF if currency is missing
      acc[currency] = (acc[currency] || 0) + (p.montant || 0);
    });
    return acc;
  }, {});
  
  
  const pendingOrders = orders.filter((o) => o.statut === "En attente").length;

  const orderData = orders.map((o) => {
    const amountByCurrency = o.proformas.reduce((acc, p) => {
      const currency = p.devise || "XOF";
      acc[currency] = (acc[currency] || 0) + (p.montant || 0);
      return acc;
    }, {});

    return {
      id: o.id_commande,
      amount: amountByCurrency,
      date: o.date,
      team: o.equipe,
    };
  });

  // Format the totals for display
  const currencyTotals = Object.entries(totalPaidByCurrency)
    .map(([currency, amount]) => `${amount} ${currency}`)
    .join(", ");

  const reportText = `
    *Rapport Automatisé (dernières 100 commandes)*
    - Total commandes: ${totalOrders}
    - Commandes en attente: ${pendingOrders}
    - Total payé: ${currencyTotals || '0 XOF'}
  `;

  await postSlackMessage(
    "https://slack.com/api/chat.postMessage",
    {
      channel: process.env.SLACK_ADMIN_ID,
      text: reportText,
    },
    process.env.SLACK_BOT_TOKEN
  );

  context.log(`Report sent: ${reportText}`);
}
// Analyze trends and detect anomalies
// ...existing code...
async function analyzeTrends(context) {
    console.log("** analyzeTrends");
    try {
        const orders = await Order.find({}).sort({ date: -1 }).limit(100);
        
        // Add validation before making OpenAI request
        if (!orders || orders.length === 0) {
            context.log("No orders found for trend analysis");
            return;
        }

        // Summarize orders to reduce token count
        const summarizedOrders = orders.map(order => ({
            id: order.id_commande,
            date: order.date,
            team: order.equipe,
            status: order.statut,
            totalAmount: order.proformas?.reduce((sum, p) => sum + (p.montant || 0), 0) || 0,
            currency: order.proformas?.[0]?.devise || 'XOF',
            articlesCount: order.articles?.length || 0,
            requester: order.demandeur
        }));

        // Further reduce data if still too large
        const dataToAnalyze = summarizedOrders.slice(0, 50); // Limit to 50 most recent orders

        const prompt = `Analyze these order trends and provide insights in JSON format with the following structure:
        {
          "summary": "Brief summary of trends",
          "topTeams": ["team1", "team2"],
          "averageAmountByTeam": {"team1": 1000, "team2": 2000},
          "statusDistribution": {"En attente": 10, "Validé": 15},
          "anomalies": ["Any unusual patterns"],
          "recommendations": ["Suggested actions"]
        }
        
        Orders data: ${JSON.stringify(dataToAnalyze)}`;
        
        // Add timeout and better error handling
        const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error("OpenAI request timed out")), 50000)
        );

        const openaiPromise = openai.chat.completions.create({
            model: "gpt-3.5-turbo",
            messages: [{ role: "user", content: prompt }],
            max_tokens: 800,
            temperature: 0.3,
        });

        const response = await Promise.race([openaiPromise, timeoutPromise]);
        
        // Validate response before parsing
        const content = response.choices[0]?.message?.content;
        if (!content || content.trim() === '') {
            throw new Error("Empty response from OpenAI");
        }

        let trends;
        try {
            // Clean the response to ensure it's valid JSON
            const cleanContent = content.trim();
            const jsonStart = cleanContent.indexOf('{');
            const jsonEnd = cleanContent.lastIndexOf('}') + 1;
            
            if (jsonStart !== -1 && jsonEnd > jsonStart) {
                const jsonContent = cleanContent.substring(jsonStart, jsonEnd);
                trends = JSON.parse(jsonContent);
            } else {
                throw new Error("No valid JSON found in response");
            }
        } catch (parseError) {
            context.log(`Failed to parse OpenAI response: ${content}`);
            // Fallback: create a basic trends object with actual data
            const teamCounts = dataToAnalyze.reduce((acc, order) => {
                acc[order.team] = (acc[order.team] || 0) + 1;
                return acc;
            }, {});
            
            const statusCounts = dataToAnalyze.reduce((acc, order) => {
                acc[order.status] = (acc[order.status] || 0) + 1;
                return acc;
            }, {});

            trends = {
                summary: `Analyse de ${dataToAnalyze.length} commandes récentes`,
                topTeams: Object.keys(teamCounts).slice(0, 3),
                statusDistribution: statusCounts,
                error: "AI parsing failed, showing basic stats",
                totalOrders: dataToAnalyze.length
            };
        }

        context.log("Trend analysis:", JSON.stringify(trends));

        // Format the message for better readability
        const formattedMessage = `📊 *Analyse des Tendances*\n
📈 **Résumé:** ${trends.summary || 'Analyse des commandes récentes'}
👥 **Équipes principales:** ${trends.topTeams?.join(', ') || 'Non disponible'}
📊 **Distribution des statuts:** ${Object.entries(trends.statusDistribution || {}).map(([status, count]) => `${status}: ${count}`).join(', ')}
${trends.anomalies?.length ? `⚠️ **Anomalies:** ${trends.anomalies.join(', ')}` : ''}
${trends.recommendations?.length ? `💡 **Recommandations:** ${trends.recommendations.join(', ')}` : ''}`;

        // Send trend analysis to admin
        await postSlackMessage(
            "https://slack.com/api/chat.postMessage",
            {
                channel: process.env.SLACK_ADMIN_ID,
                text: formattedMessage,
            },
            process.env.SLACK_BOT_TOKEN
        );

    } catch (error) {
        context.log(`Error in trend analysis: ${error.message}`);
        
        // Send error notification instead of crashing
        try {
            await postSlackMessage(
                "https://slack.com/api/chat.postMessage",
                {
                    channel: process.env.SLACK_ADMIN_ID,
                    text: `❌ *Erreur dans l'analyse des tendances*\n${error.message}`,
                },
                process.env.SLACK_BOT_TOKEN
            );
        } catch (notificationError) {
            context.log(`Failed to send error notification: ${notificationError.message}`);
        }
    }
}
// ...existing code...

// Schedule reports and trend analysis (e.g., daily at 9 AM)
function  setupReporting(context) {

  console.log("** setupReporting");
  if (isScheduledR) {
    console.log("Reporting already scheduled, skipping duplicate setup.");
    return;
  }
  cron.schedule("23 1 * * *", async () => {
    await generateReport(context);
    await analyzeTrends(context);
  });
  isScheduledR = true; // Set after scheduling
  console.log("Delay monitoring scheduled to run 12pm.");
}

module.exports = {
  generateReport,
  analyzeTrends,
  setupReporting,
};
