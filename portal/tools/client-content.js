// Text of the CLIENT guide (portal/help.html): how to use the system, for realtors and lenders.
// Rules for this file (the tests enforce them): plain words; no staff, rep-management or sign-in-management text; NO talk of rates, prices CLA charges,
// special or standard fees, discounts or dollar amounts; only pictures taken as a client or a guest, with every dollar figure in the picture replaced by zeros.
// `node portal/tools/build-help.js` turns it into portal/help.html (the staff manual is built from help-content.js).
const S = [];
const sec = (id, n, title, intro, blocks) => S.push({ id, n, title, aud: "C", intro, blocks });

sec("welcome", 1, "Welcome", "This guide shows you how to get a closing cost estimate, save it, and print or share it.", [
  { t: "table", cols: ["Part", "What it is"], rows: [
    ["Closing cost calculator", "Gives you an estimate of the closing costs for a purchase, a cash purchase or a refinance, and what a seller would walk away with. Anyone can use it, signed in or not."],
    ["Your quotes page", "When you sign in, the quotes you run are saved to your account. This page lists them so you can open, print or delete them. It also shows your profile and your CLA rep."],
  ] },
  { t: "note", tone: "warning", x: "An estimate is not a guarantee. It is not a Loan Estimate, a Closing Disclosure or a promise to insure. For a binding quote, ask your CLA rep." },
  { t: "p", x: "Use your browser's Find (Ctrl+F, or Cmd+F on a Mac) to search this page. The pictures use made-up sample people and addresses, and every dollar figure in them has been replaced with zeros." },
]);

sec("signing-in", 2, "Signing in", "There is no public sign-up. CLA sends you an email invitation, and you sign in with that same email address.", [
  { t: "h3", x: "Your first time: the invitation email" },
  { t: "ol", items: [
    ["Open the email from CLA and click the link", "The link works for 24 hours. If it has lapsed, see \"Link expired or forgot your password\" below."],
    ["Choose a password", "At least 12 characters, with upper and lower case letters and a number. Type it twice."],
    ["Accept the privacy notice and terms", "Tick the box, then choose Create my account."],
    ["Finish your profile", "Add your name and company. A photo is optional. See \"Your profile and photo\"."],
  ] },
  { t: "h3", x: "Signing in after that" },
  { t: "ol", items: [
    ["Open the sign-in page", "Go to quotes.clatitle.com/portal/login.html, or choose Log in at the top of the calculator."],
    ["Enter your email and password", "Use the email address CLA invited. Choose Sign in."],
    ["You land on your quotes page", "From there choose New quote, or Calculator in the top bar, to run another."],
  ] },
  { t: "img", f: "login.png", cap: "The sign-in page.", alt: "Sign-in page with email and password fields" },
  { t: "h3", x: "Link expired or forgot your password" },
  { t: "ol", items: [
    ["Open the sign-in page and choose Forgot password?", ""],
    ["Enter your email and choose Send reset link", "You always see the same message, whether or not the email is on file: \"If that email has a CLA portal account, a reset link is on its way.\" You can ask for another link after about a minute."],
    ["Open the newest email and choose a new password", "Reset links also last 24 hours. A used or expired link says \"This link has expired or was already used. Request a new one from the sign-in page.\" Choose Forgot password? again for a fresh one."],
  ] },
  { t: "img", f: "forgot.png", cap: "After you ask for a reset link.", alt: "Reset password page after sending a link" },
  { t: "p", x: "To sign out, choose Sign out in the top bar." },
]);

sec("getting-an-estimate", 3, "Getting an estimate, step by step", "Open the calculator from the top bar (Calculator) or with New quote on your quotes page. You can use it without signing in, but only signed-in quotes are saved.", [
  { t: "img", f: "calc-top.png", cap: "The top of the calculator: the Buyer Quote / Seller Net Sheet switch, Reload team sheet and Take the tour. (Amounts are shown as zeros in this guide.)", alt: "Calculator header and mode switch" },
  { t: "ol", items: [
    ["Pick Buyer Quote or Seller Net Sheet", "Buyer Quote shows what a buyer pays at closing. Seller Net Sheet shows what a seller keeps. Both are explained below."],
    ["Pick the type of transaction", "Purchase is a financed sale. Cash has no loan. Refinance replaces the sale price with the payoff of the old loan and the amount of the new one."],
    ["Enter the ZIP code", "The state and county fill in by themselves, because county taxes depend on them. The address and city are optional and show on your quote."],
    ["Check the county or city", "You can change it in the County / city list."],
    ["Enter the price and the loan amount", "On a refinance, enter the payoff and the new loan amount."],
    ["Choose the policy options", "Owner's policy, who pays for it, and how fees are shown."],
    ["Tick endorsements and check the documents", "Both are under Fees & options. The starting choices match a typical purchase, so change only what applies to you."],
    ["Read the estimate on the right", "It updates with every change you make. Then save, print or copy it (see \"Saving, printing and sharing a quote\")."],
  ] },
  { t: "img", f: "calc-inputs.png", cap: "The inputs on the left and the estimate on the right. Example amounts shown here are for illustration only.", alt: "Calculator inputs and estimate" },
  { t: "h3", x: "The inputs in plain words" },
  { t: "table", cols: ["Input", "What it does"], rows: [
    ["Purchase / Cash / Refinance", "Purchase: a financed sale. Cash: no loan, so no lender's policy and no lender-only fees. Refinance: a payoff and a new loan, with no owner's policy and no seller column."],
    ["Property address, City", "Optional. They print on your quote and appear on the saved quote."],
    ["ZIP", "Five digits. It fills in the state and county. If a ZIP covers more than one county, the page says so. If a ZIP is not on file, you pick the state and county yourself (CLA covers MD, VA, DC and FL)."],
    ["State, County / city", "MD, DC, VA or FL. The county or city decides county recording fees and transfer taxes. Until you choose one, the page says \"Enter a ZIP or choose a county to include county taxes.\""],
    ["Underwriter", "The title insurance company whose policy is quoted."],
    ["Sale price, Payoff, Loan amount", "The price is not used on a refinance. Payoff and loan show on a refinance. Loan is hidden on a cash purchase."],
    ["Owner's policy", "Enhanced / Homeowner's or Standard coverage."],
    ["Reissue or basic option", "Reissue means a title policy on the property already exists, which can change the premium. Leave it on Basic if you are not sure."],
    ["Owner's policy paid by", "Local custom (what is usual in that county), Buyer or Seller."],
    ["Fee presentation", "Loan Estimate / CD (TRID) shows premiums the way the lender's forms do. Actual premium split shows what each person really pays."],
    ["First-time homebuyer", "Applies a first-time buyer exemption or treatment where the county has one. Not used on a refinance."],
    ["Owner-occupied principal residence", "On by default. Some exemptions depend on it. In Maryland, a long deed that is not a principal residence can record differently, and a note on the page says so."],
    ["Buyer pays seller's transfer / deed tax", "A contract term, for example Florida deed stamps. It moves the seller's tax to the buyer column."],
    ["Documents to record", "How many Deeds, Deeds of Trust, Releases and Powers of Attorney, and how many pages each. The starting numbers match a typical CLA quote."],
    ["Endorsements", "Optional extra coverage. A few are ticked to begin with. The choices depend on the state, the underwriter and the type of transaction."],
    ["CLA fees", "Locked: you cannot edit them. They are tagged Buyer or Seller and come from CLA's current fee list."],
  ] },
  { t: "h3", x: "Seller Net Sheet" },
  { t: "p", x: "Choose Seller Net Sheet to see what a seller keeps. Address, ZIP, state, county and price carry across when you switch." },
  { t: "ul", items: [
    "Property and sale: address, ZIP, state, county, selling price and closing date.",
    "Commissions: the buyer's broker and the seller's broker, each as a percent or a dollar amount.",
    "Payoffs and property taxes: first mortgage payoff, second mortgage or HELOC, yearly property taxes and the date they are paid through. Taxes are shared by days: the seller owns every day up to the day before closing, using a 365-day year.",
    "Credits and other costs: seller concession, HOA dues owed, HOA transfer fee, HOA special assessment, home warranty, other costs, and up to five lines of your own, such as repairs.",
    "Title and settlement: who pays the owner's policy, whether the buyer is a first-time homebuyer, and whether the buyer pays the seller's transfer tax.",
    "Result: net proceeds are the selling price minus the seller's total costs minus the mortgage payoffs.",
  ] },
  { t: "img", f: "calc-seller.png", cap: "The Seller Net Sheet. Example amounts shown here are for illustration only.", alt: "Seller net sheet" },
]);

sec("results", 4, "What your results mean", "The estimate on the right of the calculator, and the same layout on a saved quote.", [
  { t: "img", f: "calc-results.png", cap: "The headline total, the sections and the estimate total. Example amounts shown here are for illustration only.", alt: "Calculator results" },
  { t: "h3", x: "How the page is laid out" },
  { t: "ul", items: [
    "The big number at the top is the buyer total (the borrower total on a refinance). Under it are the seller total and the all-parties total.",
    "Below that, lines are grouped under letters: B Services you cannot shop for, C Services you can shop for, E Taxes and other government fees, H Other. Each group has a buyer column (the borrower, on a refinance), a seller column and a group total.",
    "An Estimate total closes the page. The line under the headline names the transaction, county, state and underwriter.",
    "If a line has a dash in a column, nothing is charged to that person for it.",
    "If the line under the headline says BUILT-IN SNAPSHOT, the page could not reach CLA's latest fee list. Choose Reload team sheet to try again.",
  ] },
  { t: "h3", x: "What each kind of line is" },
  { t: "table", cols: ["Line", "What it is"], rows: [
    ["Title insurance: Lender's policy", "Insurance that protects the lender's loan. Only when there is a loan."],
    ["Title insurance: Owner's policy (optional)", "Insurance that protects the buyer's ownership of the property. Not on a refinance. Marked \"simultaneous-issue\" when it is bought together with a lender's policy."],
    ["Endorsements", "Extra coverage added to a title policy."],
    ["Settlement fee (closing fee) to CLA Title & Escrow", "CLA's fee for handling the closing."],
    ["Other CLA fees", "Smaller fees for the work around a closing, such as preparing documents, notary, secure document storage, title review, title search and abstract, a closing protection letter (lender only), and electronic recording."],
    ["Recording fees", "What the county charges to record each document (a deed, a deed of trust, a release) in the land records. Shown as \"x2\" and so on when there is more than one."],
    ["Transfer and recordation taxes", "State, county or city taxes paid when ownership or a loan is recorded. Who pays follows local custom and your contract; some are split."],
    ["Warnings box", "A yellow box that appears when something could not be calculated, for example no recording fee found for a county. Treat the total as incomplete until you understand the warning, and ask your CLA rep."],
  ] },
  { t: "h3", x: "An estimate, not a guarantee" },
  { t: "ul", items: [
    "Included: the title insurance, CLA, recording and tax lines shown on the page, for the choices you made. Anything not listed on the page is not in the total.",
    "Not included: charges from other companies, such as a lender's own fees, and anything the calculator does not list. Your lender's Loan Estimate and Closing Disclosure are the documents to rely on for those.",
    "Why the numbers can change by closing: you may change a choice (price, loan amount, who pays for the policy, the documents to record), the county or city may be different, CLA's fee list may be updated, or the final contract terms may differ.",
    "The footer on every printed and saved quote says it is an estimate, not a Loan Estimate or Closing Disclosure, and that actual charges may vary. For a binding quote, contact CLA.",
  ] },
]);

sec("saving", 5, "Saving, printing and sharing a quote", "Here is everything the system offers for keeping a quote and passing it on.", [
  { t: "h3", x: "Saving" },
  { t: "ul", items: [
    "While you are signed in, your quote saves by itself about 2.5 seconds after you change something. Opening the page does not save anything. It keeps updating the same quote.",
    "The note under the buttons says \"Saved to your account\", shows the date the quote will delete itself, and links to View with photos and My quotes.",
    "Save as new quote makes a second copy, so you can keep this version and keep changing the first. The Buyer and Seller tabs save as separate quotes.",
    "If you are not signed in, the button says Log in to save. After you sign in, a confirmation page saves the quote you were working on.",
    "Your CLA rep can see the quotes you save, so they can help you with questions. The confirmation page says so.",
  ] },
  { t: "img", f: "calc-saved.png", cap: "After a change, your quote saves by itself.", alt: "Saved to your account note under the buttons" },
  { t: "h3", x: "Print or save as a PDF" },
  { t: "ol", items: [
    ["Choose Print / Save PDF", "On the calculator, or at the top of a saved quote. Your browser's print window opens. The printed page leaves out the input boxes and buttons and shows a clean copy of the estimate, with the CLA header."],
    ["To keep a file, pick Save as PDF as the printer", "To print on paper, pick your printer."],
  ] },
  { t: "h3", x: "Copy the quote as text" },
  { t: "p", x: "On the calculator, choose Copy quote. It puts a plain-text version on your clipboard, with the address, the type of transaction, the county, every line, the totals and the estimate-only note. Paste it into an email or a text message. If your browser blocks copying, a box opens with the text so you can copy it yourself." },
  { t: "h3", x: "What is not offered" },
  { t: "p", x: "There is no button to email a quote from the portal, no share link and no separate download button. The ways to get a quote out are Print / Save PDF and Copy quote. If you would like CLA to send a quote to someone, ask your CLA rep." },
]);

sec("quotes-page", 6, "Opening and using your saved quotes", "Choose Dashboard in the top bar any time to come back to your quotes page.", [
  { t: "img", f: "client-header.png", cap: "The top bar: Calculator, Dashboard, Help, Take the tour, your name and Sign out.", alt: "Portal top bar for a signed-in client" },
  { t: "ul", items: [
    "My profile: your name, company and contact details, with a link to edit them and your photo.",
    "My CLA rep: your rep's name, photo and phone numbers (see \"Your CLA rep\").",
    "Saved quotes: each quote with its type (Buyer quote, Refinance or Seller net), price, the date saved, and how long it has left.",
  ] },
  { t: "img", f: "client-dashboard.png", cap: "Your quotes page with a few saved quotes. Example amounts shown here are for illustration only.", alt: "Client quotes page with profile, rep and saved quotes" },
  { t: "h3", x: "Open, print or delete a quote" },
  { t: "ol", items: [
    ["Choose View / print on the quote", "The quote opens with your photo and your rep's photo at the top, the headline total, every section, and any warnings."],
    ["Choose Print / Save PDF to keep a copy", "See \"Print or save as a PDF\" above. Choose Back to return to your list."],
    ["To remove a quote, choose Delete", "You are asked to confirm. A deleted quote cannot be brought back."],
  ] },
  { t: "img", f: "quote-view.png", cap: "A saved quote, ready to print. Example amounts shown here are for illustration only.", alt: "A saved quote with client and rep photos" },
  { t: "h3", x: "What you see on a quote" },
  { t: "table", cols: ["On the quote", "What it means"], rows: [
    ["Label (for example \"Buyer quote, 123 Main St\")", "A name the system gives the quote from its type and the address you entered, so you can tell quotes apart in your list. With no address it says \"no address\"."],
    ["Your details and your rep's", "At the top: your photo, name and the contact details from your profile (company, phones, address, website, license / NMLS number), then your CLA rep's photo, name, phone and email, so whoever you give the quote to knows who prepared it."],
    ["Address and \"Prepared\" date", "The property you entered and the day the quote was first saved."],
    ["\"Fees:\" line", "Which version of CLA's fee list the estimate used, with its date."],
    ["Headline total", "The buyer total (borrower total on a refinance), or the net proceeds on a seller net sheet."],
    ["\"Auto-deletes ... (N days left)\"", "The day the system will remove the quote, 30 days after it was created. Editing a quote does not restart that clock. It is highlighted when only a few days are left."],
  ] },
  { t: "p", x: "A quote does not show a \"valid until\" date. The auto-delete date is only about how long the system keeps your copy, not how long the numbers can be relied on. Ask your CLA rep how long an estimate holds." },
  { t: "h3", x: "Using a saved quote when you talk to others" },
  { t: "ul", items: [
    "With a buyer or seller: send the PDF or the pasted text, and point to the headline total first, then to the section letters (B, C, E, H) for the details.",
    "With a lender: give them the PDF so they can compare the title and settlement lines with their own Loan Estimate. Differences are normal until the details are final.",
    "With an agent: the label and address make it easy to match a quote to a property. Say which transaction type you chose.",
    "Always say it is an estimate. The date prepared and the \"Fees:\" line show how current it is.",
    "Print or copy anything you want to keep: quotes delete themselves after 30 days. If you open one that is gone, you see \"That quote was not found.\"",
  ] },
]);

sec("new-quotes", 7, "Starting a new quote and comparing", "Run as many quotes as you like. Each signed-in quote is saved separately.", [
  { t: "ol", items: [
    ["Choose New quote on your quotes page, or Calculator in the top bar", "A fresh calculator opens."],
    ["Compare two situations with Save as new quote", "Set up the first situation, choose Save as new quote, then change the price, loan amount, county or other choices. The first stays saved as it was, and the changes go into a new copy."],
    ["Check your list", "Each quote shows its type, price and the date saved, so you can open them one after another and compare the totals."],
    ["Changing the numbers later", "A saved quote is opened to view and print, not to edit. To change it, run it again in the calculator. While you stay on the calculator page, changes keep updating the same saved quote."],
  ] },
  { t: "p", x: "Tip: print or copy the version you want to keep before you start changing things." },
]);

sec("profile", 8, "Your profile and photo", "Open your name in the top bar, or choose Edit profile and photo on your quotes page.", [
  { t: "ul", items: [
    "First and last name are required. Add your company so quotes carry your details.",
    "Phone, cell phone, company phone, company address, website and license / NMLS number are optional. The ones you fill in print under your name at the top of your quotes, next to your photo and your CLA rep's details. Leave a box empty and it simply does not appear.",
    "Your cell phone is optional. It must be a US number, for example (240) 555-0142, your CLA rep can see it, and it prints on your quotes.",
    "To change the email you sign in with, contact CLA.",
  ] },
  { t: "p", x: "A photo is optional. Use a JPEG or PNG up to 2 MB. The portal crops it to a centered square and shrinks it to 512 pixels. iPhone HEIC photos are not accepted yet: take a screenshot of the photo or save it as a JPEG first. Choose Choose photo, then Upload this photo. Choose Remove photo to go back to the placeholder." },
  { t: "img", f: "profile.png", cap: "The photo box on your profile page.", alt: "Profile photo box" },
  { t: "img", f: "profile-company.png", cap: "The company details on your profile page.", alt: "Profile company details" },
  { t: "img", f: "calc-cobrand.png", cap: "Your photo and contact details, and your rep's (with their email), show at the top of the calculator when you are signed in, and on printed quotes.", alt: "Calculator header with client and rep photo bar" },
]);

sec("your-rep", 9, "Your CLA rep", "The rep CLA has matched you with is your first call for any question about a quote.", [
  { t: "ul", items: [
    "Your quotes page has a My CLA rep box with your rep's name, photo, cell phone (tap it on a phone to call), office phone and email address (click it to write an email).",
    "Your rep's name and number also print on your quotes.",
    "If the box says you have not been matched to a CLA rep yet, your quotes still save, and CLA will connect you by email.",
  ] },
]);

sec("tour", 10, "The guided tour", "A short click-through in John's voice, about a minute long.", [
  { t: "ul", items: [
    "On your quotes page it starts by itself the first time you arrive after finishing your profile. Replay it any time with Take the tour in the top bar.",
    "The calculator has its own tour, for anyone, signed in or not. Use Take the tour in the calculator header, or the \"New here?\" note.",
    "Choose Next and Back to move, or Skip tour to stop. You can close it with Esc.",
  ] },
  { t: "img", f: "tour-client-step3.png", cap: "A tour step on your quotes page.", alt: "Guided tour popup over the quotes page" },
  { t: "img", f: "tour-client-rep.png", cap: "The tour also points out where to find your rep.", alt: "Guided tour popup about your CLA rep" },
  { t: "img", f: "tour-calculator.png", cap: "The calculator tour works the same way.", alt: "Calculator guided tour step" },
]);

sec("faq", 11, "Questions and answers", "Quick fixes for the common problems. If nothing here helps, call or email your CLA rep.", [
  { t: "table", cols: ["Question", "Answer"], rows: [
    ["I can't sign in", "Use the exact email address CLA invited. There is no public sign-up. Check your password, then choose Forgot password? on the sign-in page."],
    ["My link expired or says it was already used", "Links last 24 hours. On the sign-in page choose Forgot password? to get a fresh link."],
    ["The reset email didn't arrive", "The page gives the same message whether or not the email is on file. Check your spam folder, wait a minute and try again, and make sure you typed the address CLA invited."],
    ["Can I download a quote?", "Choose Print / Save PDF and pick Save as PDF as the printer. There is no separate download button."],
    ["Can I email or share a quote from the portal?", "Not from a button. Save it as a PDF or use Copy quote, then paste or attach it in your own email or message. Or ask your CLA rep to send it."],
    ["How long is an estimate good for?", "A quote shows when it will be deleted, not a \"valid until\" date. Ask your CLA rep how long an estimate holds."],
    ["Why is my estimate different from my lender's?", "The calculator covers the title, settlement, recording and tax lines on the page. Your lender's Loan Estimate includes other charges, and details can change before closing. Ask your CLA rep or your lender to walk through the differences."],
    ["I can't see a quote", "Quotes delete themselves 30 days after they were created, or you may have deleted it. Make sure you are signed in with the same email you used to run it. Run a new quote and it will save."],
    ["The quote didn't save", "Check that the note under the buttons says \"Saved to your account\". If it says it could not save, sign in again and retry. What you see on screen is still fine to print or copy."],
    ["My quote looks wrong", "Check the ZIP and county, the transaction type, who pays the owner's policy, TRID versus actual split, the first-time buyer and principal residence boxes, the document counts, and any yellow warnings. Choose Reload team sheet. It is still only an estimate, so ask your CLA rep."],
    ["My photo won't upload", "Use a JPEG or PNG up to 2 MB. iPhone HEIC photos are not accepted yet."],
    ["The phone number is rejected", "Use a US number, for example (240) 555-0142."],
    ["I don't have a rep on my page", "Your quotes still save. CLA will connect you by email."],
    ["How do I see the tour again?", "Choose Take the tour in the top bar."],
    ["I can't use the page I opened", "Choose Dashboard in the top bar to go back to your quotes."],
  ] },
]);

sec("glossary", 12, "Glossary", "Plain-English meanings for the terms you will see.", [
  { t: "table", cols: ["Term", "Meaning"], rows: [
    ["Estimate", "A close guess of the charges, not a promise of the final numbers."],
    ["Owner's policy", "Title insurance that protects the buyer's ownership."],
    ["Lender's policy", "Title insurance that protects the lender's loan."],
    ["Simultaneous issue", "Buying both policies at once."],
    ["Endorsement", "An add-on that extends a policy's coverage."],
    ["Reissue", "A title policy on the property already exists."],
    ["Settlement fee, closing fee", "CLA's fee for handling the closing."],
    ["Recording fee", "What the county charges to record a document in the land records."],
    ["Transfer tax, recordation tax", "Taxes paid to the state or county when ownership or a loan is recorded."],
    ["Deed, Deed of Trust, Release", "The documents recorded for a sale, for a loan, and for paying off a loan."],
    ["Power of attorney", "A document that lets someone sign for another person."],
    ["TRID, Loan Estimate, Closing Disclosure", "The federal rules and lender forms that show closing costs."],
    ["CPL", "Closing protection letter, a lender-required assurance about the closing agent."],
    ["Underwriter", "The insurance company that issues the title policy."],
    ["Proration", "Splitting a recurring cost, such as property tax, by days between seller and buyer."],
    ["Payoff", "The amount needed to close out an existing loan."],
    ["HELOC", "Home equity line of credit."],
    ["Concession", "A credit the seller gives the buyer."],
    ["Net sheet", "An estimate of what the seller walks away with."],
    ["Principal residence", "The home the owner lives in as a main home."],
    ["Title search, abstract", "Research into the property's ownership and any claims against it."],
    ["E-recording", "Recording documents electronically."],
    ["Label", "The name the system gives a saved quote from its type and address."],
    ["Auto-deletes", "The day the system removes a saved quote, 30 days after it was created."],
  ] },
]);

module.exports = { S };
