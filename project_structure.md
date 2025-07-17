# Project Structure Overview

## 📁 scripts/src/

### 🏦 Caisse Module
Complete cash management system with approval workflows, funding requests, and payment processing.

#### 📂 Caisse/Handlers/
- **caisseApprovalHandlers.js** - *Approval Workflow Management*
  - `openPreApprovalConfirmationDialog` - Opens pre-approval confirmation dialog
  - `handlePreApproval` - Processes pre-approval requests
  - `openFinalApprovalConfirmationDialog` - Opens final approval confirmation dialog
  - `handleFinalApprovalConfirmation` - Handles final approval confirmation
  - `processFundingApproval` - Processes funding approval workflow

- **caisseCorrectionHandlers.js** - *Error Correction & Amendments*
  - `generateCorrectionModal` - Creates correction modal interface
  - `handleCorrectionSubmission` - Processes correction form submissions

- **caisseFundingRequestHandlers.js** - *Funding Request Management*
  - `handleOpenFundingForm` - Opens funding request form
  - `generateFundingRequestForm` - Creates funding request form interface
  - `handleFundingRequestSubmission` - Processes funding request submissions
  - `generateFundingDetailsBlocks` - Creates funding details UI blocks
  - `generateRequestDetailBlocks` - Creates request detail UI blocks
  - `getPaymentMethodText` - Retrieves payment method descriptions
  - `generateFundingRequestBlocks` - Creates funding request UI blocks
  - `getCaisseTypes` - Retrieves available caisse types

- **caissePaymentHandlers.js** - *Payment Processing*
  - `handleFillFundingDetails` - Handles funding details completion
  - `generateFundingApprovalPaymentModal` - Creates payment approval modal
  - `FinanceDetailsSubmission` - Processes finance details submission
  - `handlePaymentMethodSelection` - Handles payment method selection
  - `handlePaymentModificationSubmission` - Processes payment modifications

- **caisseProblemHandlers.js** - *Problem Resolution*
  - `handleFundProblemSubmission` - Handles fund-related problem submissions
  - `handlePaymentProblemSubmission` - Handles payment-related problem submissions
  - `handleFundProblemModal` - Manages fund problem modal interface
  - `getProblemTypeText` - Retrieves problem type descriptions

- **caisseRejectionHandlers.js** - *Rejection Management*
  - `openRejectionReasonModalFund` - Opens rejection reason modal for funding
  - `handleRejectFunding` - Processes funding rejection

#### 📂 Transfer/
- **transferForms.js** - *Transfer Form Management*
  - `getTransferredPaymentBlocks` - Creates transferred payment UI blocks
  - `getFinancePaymentBlocksForTransfer` - Creates finance payment blocks for transfers

- **transferHandlers.js** - *Transfer Processing*
  - `handleTransferApprovalConfirmation` - Handles transfer approval confirmation
  - `createAndSaveTransferRequest` - Creates and saves transfer requests
  - `openTransferApprovalConfirmation` - Opens transfer approval confirmation
  - `handleTransferToCaisse` - Handles transfers to caisse
  - `handleTransferConfirmation` - Handles transfer confirmation

- **transferNotifications.js** - *Transfer Notifications*
  - `notifyAdminTransfer` - Notifies admin about transfers
  - `notifyUserTransfer` - Notifies users about transfers

- **transferRejection.js** - *Transfer Rejection*
  - `openTransferRejectionReason` - Opens transfer rejection reason modal
  - `handleTransferRejectionReason` - Handles transfer rejection reason submission

#### 📂 CaisseSubcommands.js - *Caisse Command Interface*
- `handleCaisseTextParsing` - Parses caisse-related text commands
- `handleCaisseBalanceCommand` - Handles balance inquiry commands
- `handleCaisseCreateCommand` - Handles caisse creation commands
- `handleCaisseDeleteCommand` - Handles caisse deletion commands
- `handleCaisseListCommand` - Handles caisse listing commands
- `handleCaisseTransferCommand` - Handles transfer commands
- `handleCaisseWelcomeMessage` - Handles welcome message display

---

### 🔧 Common Module
Shared utilities and services used across all modules.

#### 📂 Common/
- **aiService.js** - *AI Integration & Processing*
  - `summarizeOrder` - Summarizes order information using AI
  - `parseOrderFromText` - Parses order details from text input
  - `summarizeOrdersWithChat` - Summarizes multiple orders with chat context
  - `checkFormErrors` - Validates form data using AI
  - `suggestAutoCompletions` - Provides AI-powered auto-completions
  - `handleFrequentQuestions` - Handles frequently asked questions
  - `getOrderSummary` - Generates order summaries

- **notifyProblem.js** - *Problem Notification*
  - `notifyTechSlack` - Notifies technical team via Slack

- **slackUtils.js** - *Slack Integration Utilities*
  - `createSlackResponse` - Creates Slack response objects
  - `verifySlackSignature` - Verifies Slack request signatures
  - `postSlackMessage` - Posts messages to Slack
  - `postSlackMessage9` - Alternative Slack message posting
  - `postSlackMessage2` - Secondary Slack message posting
  - `postSlackMessageWithRetry` - Posts Slack messages with retry logic
  - `updateSlackMessage1` - Updates existing Slack messages

- **utils.js** - *General Utilities*
  - `fetchEntity` - Fetches entity data
  - `bankOptions` - Provides bank options
  - `isValidUrl` - Validates URL format
  - `getFileInfo` - Retrieves file information

---

### ⚙️ Configurations Module
System configuration and role management.

#### 📂 Configurations/
- **config.js** - *System Configuration*
  - `getConfigValues` - Retrieves configuration values
  - `updateConfigValues` - Updates configuration values
  - `addConfigValue` - Adds new configuration values
  - `removeConfigValue` - Removes configuration values
  - `getEquipeOptions` - Retrieves team options
  - `getUnitOptions` - Retrieves unit options
  - `getCurrencies` - Retrieves currency options
  - `getFournisseurOptions` - Retrieves supplier options

- **roles.js** - *Role Management*
  - `getUserRoles` - Retrieves user roles
  - `isAdminUser` - Checks if user is admin
  - `isFinanceUser` - Checks if user is finance user
  - `isPurchaseUser` - Checks if user is purchase user
  - `addUserRole` - Adds role to user
  - `removeUserRole` - Removes role from user

---

### 🗄️ Database Module
Database models and utilities for data persistence.

#### 📂 Database/
- **config/database.js** - *Database Configuration*

- **dbModels/** - *Data Models*
  - **Caisse.js** - `Caisse`, `DecaissementCounter`, `PaymentCounter`
  - **CommandSequence.js** - `CommandSequence`
  - **Config.js** - `Config`
  - **FormData.js** - `FormData`
  - **Order.js** - `Order`
  - **OrderMessage.js** - `OrderMessage`
  - **PaymentRequest.js** - `PaymentRequest`
  - **PaymentSequence.js** - `PaymentSequence`
  - **UserRole.js** - `UserRole`

- **databaseUtils.js** - *Database Utilities*
  - `getOrderMessageFromDB` - Retrieves order messages from database
  - `saveOrderMessageToDB` - Saves order messages to database
  - `saveMessageReference` - Saves message references
  - `getMessageReference` - Retrieves message references
  - `getFromStorage` - Retrieves data from storage

---

### ⏰ Delays Module
Automated delay monitoring and reminder system.

#### 📂 Delays/
- **handleDelay.js** - *Order Delay Management*
  - `checkPendingOrderDelays` - Checks for pending order delays
  - `sendDelayReminder` - Sends delay reminder notifications
  - `checkPaymentDelays` - Checks for payment delays
  - `checkProformaDelays` - Checks for proforma delays
  - `setupDelayMonitoring` - Sets up delay monitoring system

- **handleDelayPayment.js** - *Payment Request Delay Management*
  - `checkPendingPaymentRequestDelays` - Checks pending payment request delays
  - `checkPaymentRequestApprovalDelays` - Checks payment request approval delays
  - `setupPaymentRequestDelayMonitoring` - Sets up payment request delay monitoring

---

### 📊 Excel Module
Excel integration and reporting services.

#### 📂 Excel/
- **Caisse/reportService.js** - *Caisse Reporting*
  - `generateReport` - Generates caisse reports
  - `analyzeTrends` - Analyzes financial trends
  - `setupReporting` - Sets up reporting configuration

- **Common/Excel.js** - *Excel Common Services*
  - `getGraphClient` - Gets Microsoft Graph client
  - `addRowToExcel` - Adds rows to Excel spreadsheets
  - `findRowIndex` - Finds row index in Excel data
  - `updateRowInExcel` - Updates Excel rows
  - `getSiteId` - Gets SharePoint site ID
  - `getFileId` - Gets Excel file ID
  - `getDriveId` - Gets OneDrive drive ID

- **Order/Order.js** - *Order Excel Integration*
  - `syncOrderToExcel` - Synchronizes orders to Excel

- **PaymentRequest/PaymentRequest.js** - *Payment Request Excel Integration*
  - `syncPaymentRequestToExcel` - Synchronizes payment requests to Excel

- **exportService.js** - *Export Services*
  - `exportReport` - Exports reports to Excel

- **report.js** - *Reporting Services*
  - `syncCaisseToExcel` - Synchronizes caisse data to Excel

---

### 🎛️ MainHandlers Module
Core system handlers for Slack interactions.

#### 📂 MainHandlers/
- **handleBlockActions.js** - *Block Action Handler*
  - `handleBlockActions` - Handles Slack block actions

- **handleViewSubmission.js** - *View Submission Handler*
  - `handleViewSubmission` - Handles Slack view submissions

- **orderSlackApi.js** - *Order Slack API*
  - `handleOrderSlackApi` - Handles order-related Slack API calls

- **slackInteractions.js** - *Slack Interaction Handler*
  - `handleSlackInteractions` - Handles general Slack interactions

---

### 📦 Order Module
Complete order management system with approval workflows.

#### 📂 Order/Handlers/
- **orderApprovalHandlers.js** - *Order Approval Management*
  - `handlePaymentVerification` - Handles payment verification process
  - `handlePaymentVerificationConfirm` - Confirms payment verification
  - `handleOrderStatus` - Manages order status updates
  - `createPaymentConfirmationModal` - Creates payment confirmation modal

- **orderFormBlockHandlers.js** - *Order Form UI Management*
  - `generateOrderForm` - Creates order form interface
  - `handleAddProforma` - Handles proforma addition
  - `generateProformaBlocks` - Creates proforma UI blocks
  - `handleAddArticle` - Handles article addition
  - `handleCancelProforma` - Handles proforma cancellation
  - `handleRemoveArticle` - Handles article removal
  - `generateArticleBlocks` - Creates article UI blocks

- **orderFormHandlers.js** - *Order Form Processing*
  - `handleOrderFormSubmission` - Processes order form submissions
  - `handleDynamicFormUpdates` - Handles dynamic form updates
  - `handleOpenOrderForm` - Opens order form interface
  - `createAndSaveOrder` - Creates and saves orders

- **orderMessageBlocks.js** - *Order Message UI*
  - `getOrderBlocks` - Creates order UI blocks
  - `getProformaBlocks1` - Creates proforma blocks (variant 1)
  - `getProformaBlocks` - Creates proforma blocks (main)
  - `generateArticlePhotosBlocks` - Creates article photo blocks
  - `generateArticleBlocks` - Creates article blocks

- **orderModification.js** - *Order Modification*
  - `handleEditOrder` - Handles order editing

- **orderNotificationService.js** - *Order Notifications*
  - `notifyAdmin` - Notifies admin about orders
  - `notifyUserAI` - Notifies users with AI assistance
  - `notifyUser` - Notifies users about orders
  - `notifyTeams` - Notifies teams about orders

- **orderRejectionHandlers.js** - *Order Rejection Management*
  - `openRejectionReasonModal` - Opens rejection reason modal
  - `RejectionReasonSubmission` - Processes rejection reason submissions
  - `handleDeleteOrder` - Handles order deletion
  - `executeOrderDeletion` - Executes order deletion
  - `handleDeleteOrderConfirmed` - Handles confirmed order deletion

#### 📂 Payment/
- **paymentForm.js** - *Payment Form Management*
  - `handleFinancePaymentForm` - Handles finance payment forms
  - `generatePaymentForm` - Creates payment form interface

- **paymentHandlers.js** - *Payment Processing*
  - `handlePaymentFormModeSelection` - Handles payment form mode selection
  - `processPaymentSubmission` - Processes payment submissions
  - `handlePayment` - Handles payment processing
  - `handlePaymentRequestSubmission` - Handles payment request submissions
  - `handlePaymentProblemModal` - Handles payment problem modals
  - `handleModifyPayment` - Handles payment modifications
  - `calculateTotalAmountDue` - Calculates total amount due
  - `generatePaymentNumber` - Generates payment numbers

- **paymentNotifications.js** - *Payment Notifications*
  - `getPaymentBlocks` - Creates payment UI blocks
  - `notifyPayment` - Notifies about payments

#### 📂 Proforma/
- **proformaDelete.js** - *Proforma Deletion*
  - `handleDeleteProforma` - Handles proforma deletion
  - `handleDeleteProformaConfirmation` - Handles proforma deletion confirmation

- **proformaForm.js** - *Proforma Form*
  - `proforma_form` - Proforma form interface

- **proformaModification.js** - *Proforma Modification*
  - `handleEditProformaSubmission` - Handles proforma edit submissions
  - `handleEditProforma` - Handles proforma editing

- **proformaNotificationService.js** - *Proforma Notifications*
  - `notifyAdminProforma` - Notifies admin about proformas

- **proformaSubmission.js** - *Proforma Submission*
  - `handleProformaSubmission` - Handles proforma submissions
  - `extractProformas` - Extracts proforma data

- **proformaValidation.js** - *Proforma Validation*
  - `handleProformaValidationRequest` - Handles proforma validation requests
  - `validateProforma` - Validates proforma data
  - `ProformaValidationConfirm` - Confirms proforma validation

#### 📂 orderSubcommands.js - *Order Command Interface*
- `handleOrderWelcomeMessage` - Handles welcome message display
- `handleOrderMyOrderCommand` - Handles "my orders" command
- `handleOrderReportCommand` - Handles report generation commands
- `handleOrderSummaryCommand` - Handles order summary commands
- `handleOrderRemoveCommands` - Handles order removal commands
- `handleOrderRoleCommands` - Handles role-related commands
- `handleOrderAddCommands` - Handles order addition commands
- `handleOrderConfigCommands` - Handles configuration commands
- `handleOrderHelpCommand` - Handles help command
- `handleOrderListCommands` - Handles list commands
- `handleOrderTextParsing` - Parses order-related text commands
- `handleOrderAICommand` - Handles AI-related commands
- `handleOrderDeleteCommand` - Handles order deletion commands
- `handleOrderRemoveRoleCommand` - Handles role removal commands
- `handleOrderListUsersCommand` - Handles user listing commands
- `handleOrderResumeCommand` - Handles order resume commands
- `handleAICommand` - Handles AI command processing
- `view_order` - Views order details

---

### 💳 PaymentRequest Module
Payment request management and processing system.

#### 📂 PaymentRequest/Handlers/
- **paymentRequestEdition.js** - *Payment Request Editing*
  - `handleEditPayment` - Handles payment editing

- **paymentRequestForm.js** - *Payment Request Forms*
  - `generatePaymentForm1` - Creates payment form (variant 1)
  - `getFinancePaymentBlocks` - Creates finance payment blocks
  - `generatePaymentRequestForm` - Creates payment request form
  - `getPaymentRequestBlocks` - Creates payment request blocks

- **paymentRequestHandlers.js** - *Payment Request Processing*
  - `handlePaymentMethodSelection1` - Handles payment method selection
  - `handleOpenPaymentForm` - Opens payment form
  - `handlePaymentModifSubmission` - Handles payment modification submissions

- **paymentRequestNotification.js** - *Payment Request Notifications*
  - `notifyFinancePayment` - Notifies finance about payments
  - `notifyPaymentRequest` - Notifies about payment requests
  - `updateSlackPaymentMessage` - Updates Slack payment messages

#### 📂 paymentSubcommands.js - *Payment Command Interface*
- `parsePaymentFromText` - Parses payment details from text
- `createAndSavePaymentRequest` - Creates and saves payment requests
- `generatePaymentRequestId` - Generates payment request IDs
- `handlePaymentWelcomeMessage` - Handles welcome message display
- `handlePaymentReportCommand` - Handles payment report commands
- `handlePaymentTextParsing` - Parses payment-related text commands

---

## 📊 Module Summary

| Module | Files | Functions | Primary Purpose |
|--------|-------|-----------|-----------------|
| **Caisse** | 8 | 35+ | Cash management, funding, transfers |
| **Common** | 4 | 20+ | Shared utilities, AI services, Slack integration |
| **Configurations** | 2 | 12+ | System settings, role management |
| **Database** | 10 | 15+ | Data persistence, models |
| **Delays** | 2 | 8+ | Automated monitoring, reminders |
| **Excel** | 6 | 20+ | Reporting, data synchronization |
| **MainHandlers** | 4 | 4+ | Core Slack interaction handling |
| **Order** | 12 | 50+ | Order management, approval workflows |
| **PaymentRequest** | 5 | 20+ | Payment request processing |

**Total: ~52 files with 180+ functions**

This project appears to be a comprehensive business management system with integrated Slack interfaces, covering order management, payment processing, cash management, and automated workflows.