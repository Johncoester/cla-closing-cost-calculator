// Text of the CLIENT guide (portal/help.html): what a realtor or lender needs, nothing else.
// Rules for this file: plain words; no staff, rep-management, pricing-rule or sign-in-management text; only pictures taken as a client or a guest.
// `node portal/tools/build-help.js` turns it into portal/help.html (the staff manual is built from help-content.js).
const S = [];
const sec = (id, n, title, intro, blocks) => S.push({ id, n, title, aud: "C", intro, blocks });

sec("welcome", 1, "Welcome", "This guide shows you how to use CLA's closing cost calculator and your saved quotes page.", [
  { t: "table", cols: ["Part", "What it is"], rows: [
    ["Closing cost calculator", "Works out an estimate of closing costs for a purchase, a cash purchase or a refinance, and what a seller would walk away with. Anyone can use it, signed in or not."],
    ["Your quotes page", "When you sign in, the quotes you run are saved to your account. This page lists them so you can open, print or delete them. It also shows your profile and your CLA rep."],
  ] },
  { t: "note", tone: "warning", x: "Every number here is an estimate. It is not a Loan Estimate, a Closing Disclosure or a promise to insure. For a binding quote, ask your CLA rep." },
  { t: "p", x: "Use your browser's Find (Ctrl+F, or Cmd+F on a Mac) to search this page. The pictures use made-up sample people and addresses." },
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

sec("quotes-page", 3, "Your quotes page", "Choose Dashboard in the top bar any time to come back here.", [
  { t: "img", f: "client-header.png", cap: "The top bar: Calculator, Dashboard, Help, Take the tour, your name and Sign out.", alt: "Portal top bar for a signed-in client" },
  { t: "ul", items: [
    "My profile: your name, company and contact details, with a link to edit them and your photo.",
    "My CLA rep: your rep's name, photo and phone numbers (see \"Your CLA rep\").",
    "Saved quotes: each quote with its type (Buyer quote or Seller net), price, the date saved, and a note of how long it has left.",
  ] },
  { t: "img", f: "client-dashboard.png", cap: "Your quotes page with a few saved quotes.", alt: "Client quotes page with profile, rep and saved quotes" },
  { t: "h3", x: "Open, print or delete a quote" },
  { t: "ol", items: [
    ["Choose View / print on the quote", "The quote opens with your photo and your rep's photo at the top, the total, every section, and any warnings."],
    ["Choose Print / Save PDF to keep a copy", "Your browser's print window opens. Pick Save as PDF to keep a file."],
    ["To remove a quote, choose Delete", "You are asked to confirm. A deleted quote cannot be brought back."],
  ] },
  { t: "img", f: "quote-view.png", cap: "A saved quote, ready to print.", alt: "A saved quote with client and rep photos" },
  { t: "p", x: "Quotes delete themselves 30 days after they were created, and editing a quote does not restart that clock. Print or copy anything you want to keep longer. If you open a quote that is gone, you see \"That quote was not found.\"" },
]);

sec("calculator", 4, "Using the calculator", "Follow the steps below. The estimate on the right updates with every change.", [
  { t: "img", f: "calc-top.png", cap: "The top of the calculator: the Buyer Quote / Seller Net Sheet switch, Reload team sheet and Take the tour.", alt: "Calculator header and mode switch" },
  { t: "h3", x: "Step by step: a buyer quote" },
  { t: "ol", items: [
    ["Pick Buyer Quote", "Seller Net Sheet is explained further down."],
    ["Pick the type of transaction", "Purchase is a financed sale. Cash has no loan. Refinance replaces the sale price with the payoff of the old loan and the amount of the new one."],
    ["Enter the ZIP code", "The state and county fill in by themselves, because county taxes depend on them. The address and city are optional and show on your quote."],
    ["Check the county or city", "You can change it in the County / city list."],
    ["Enter the price and the loan amount", "On a refinance, enter the payoff and the new loan amount."],
    ["Choose the policy options", "Owner's policy, rate, who pays, and how fees are shown."],
    ["Tick endorsements and check the documents", "Both are under Fees & options."],
    ["Read the estimate on the right", "Then print it, copy it, or let it save."],
  ] },
  { t: "img", f: "calc-inputs.png", cap: "The inputs on the left and the estimate on the right.", alt: "Calculator inputs and estimate" },
  { t: "h3", x: "The inputs in plain words" },
  { t: "table", cols: ["Input", "What it does"], rows: [
    ["Purchase / Cash / Refinance", "Purchase: a financed sale. Cash: no loan, so no lender's policy and no lender-only fees. Refinance: a payoff and a new loan, with no owner's policy and no seller column."],
    ["Property address, City", "Optional. They print on your quote and appear on the saved quote."],
    ["ZIP", "Five digits. It fills in the state and county. If a ZIP covers more than one county, the page says so. If a ZIP is not on file, you pick the state and county yourself (CLA covers MD, VA, DC and FL)."],
    ["State, County / city", "MD, DC, VA or FL. The county or city decides county recording fees and transfer taxes. Until you choose one, the page says \"Enter a ZIP or choose a county to include county taxes.\""],
    ["Underwriter", "The title insurance company whose rates are used."],
    ["Sale price, Payoff, Loan amount", "The price is not used on a refinance. Payoff and loan show on a refinance. Loan is hidden on a cash purchase."],
    ["Owner's policy", "Enhanced / Homeowner's or Standard coverage."],
    ["Rate", "Basic, or Reissue (a policy on the property already exists, which can lower the premium)."],
    ["Owner's policy paid by", "Local custom (what is usual in that county), Buyer or Seller."],
    ["Fee presentation", "Loan Estimate / CD (TRID) shows premiums the way the lender's forms do. Actual premium split shows what each person really pays."],
    ["First-time homebuyer", "Applies a first-time buyer rate or exemption where the county has one. Not used on a refinance."],
    ["Owner-occupied principal residence", "On by default. Some exemptions depend on it. In Maryland, a long deed (10 or more pages) that is not a principal residence records for $115 instead of $60, and a note says so."],
    ["Buyer pays seller's transfer / deed tax", "A contract term, for example Florida deed stamps. It moves the seller's tax to the buyer column."],
    ["Documents to record", "How many Deeds, Deeds of Trust, Releases and Powers of Attorney, and how many pages each. The starting numbers match a typical CLA quote."],
    ["Endorsements", "Optional extra coverage. A few are ticked to begin with. The choices depend on the state, the underwriter and the type of transaction."],
    ["CLA fees", "Locked. They come straight from CLA's current fee list and are tagged Buyer or Seller."],
  ] },
  { t: "h3", x: "What each line in your estimate means" },
  { t: "p", x: "Lines are grouped under letters: B Services you cannot shop for, C Services you can shop for, E Taxes and other government fees, H Other. Each group has a buyer column (the borrower, on a refinance), a seller column and a total." },
  { t: "table", cols: ["Line", "What it is"], rows: [
    ["Title - Lender's Title Policy", "Insurance that protects the lender, based on the loan amount. Only when there is a loan."],
    ["Title - Owner's Title Policy (optional)", "Insurance that protects the buyer's ownership, based on the price. Not on a refinance. Marked \"simultaneous-issue\" when it is bought together with a loan policy."],
    ["Title - Endorsement ...", "Extra coverage added to a policy. A flat amount or a percentage of the premium."],
    ["Title - Settlement Fee to CLA Title & Escrow", "CLA's fee for handling the closing. It can differ for the buyer, the seller and a refinance."],
    ["Other CLA fees", "Document preparation, notary, secure document storage, title review and data collection, title search and abstract, closing protection letter (lender only), and electronic recording."],
    ["Recording fees - Deed, Deed of Trust, Release, Power of Attorney", "What the county charges to record each document. Shown as \"x2\" and so on when there is more than one."],
    ["Transfer and recordation taxes", "State, county or city taxes on the sale or the loan. Who pays follows local custom and your contract; some are split."],
    ["Warnings box", "A yellow box that appears when something could not be priced, for example no recording fee found for a county. Treat the total as incomplete until you understand the warning, and ask your CLA rep."],
  ] },
  { t: "h3", x: "Reading the results" },
  { t: "p", x: "The big number is the buyer total (the borrower total on a refinance), with the seller total and the all-parties total underneath. Each section lists its lines, and an Estimate total closes the page. The line under the total names the transaction, county, state and underwriter. If it says BUILT-IN SNAPSHOT, the page could not reach CLA's latest fee list: choose Reload team sheet to try again." },
  { t: "img", f: "calc-results.png", cap: "The buyer total, the sections and the estimate total.", alt: "Calculator results" },
  { t: "h3", x: "Seller Net Sheet" },
  { t: "p", x: "Choose Seller Net Sheet to see what a seller keeps. Address, ZIP, state, county and price carry across when you switch." },
  { t: "ul", items: [
    "Property and sale: address, ZIP, state, county, selling price and closing date.",
    "Commissions: the buyer's broker and the seller's broker, each as a percent or a dollar amount.",
    "Payoffs and property taxes: first mortgage payoff, second mortgage or HELOC, yearly property taxes and the date they are paid through. Taxes are shared by days: the seller owns every day up to the day before closing, using a 365-day year.",
    "Credits and other costs: seller concession (dollars or percent), HOA dues owed, HOA transfer fee, HOA special assessment, home warranty, other fees, and up to five lines of your own, such as repairs.",
    "Title and settlement: who pays the owner's policy, whether the buyer is a first-time homebuyer, whether the buyer pays the seller's transfer tax, and the CLA seller fees.",
    "Result: net proceeds are the selling price minus the seller's total costs minus the mortgage payoffs.",
  ] },
  { t: "img", f: "calc-seller.png", cap: "The Seller Net Sheet.", alt: "Seller net sheet" },
  { t: "h3", x: "Saving, copying and printing" },
  { t: "ul", items: [
    "While you are signed in, your quote saves by itself about 2.5 seconds after you change something. It keeps updating the same quote. Save as new quote makes a second copy. The Buyer and Seller tabs save as separate quotes.",
    "The note under the buttons says \"Saved to your account\", shows the date the quote will delete itself (30 days after it was created), and links to View with photos and My quotes.",
    "If you are not signed in, the button says Log in to save. After you sign in, a confirmation page saves the quote you were working on.",
    "Copy quote puts a plain-text version on your clipboard to paste into an email. Print / Save PDF opens your browser's print window.",
  ] },
  { t: "img", f: "calc-saved.png", cap: "After a change, your quote saves by itself.", alt: "Saved to your account note under the buttons" },
  { t: "h3", x: "Your photo and your rep's photo on a quote" },
  { t: "p", x: "When you are signed in, a bar under the Buyer Quote / Seller Net Sheet switch shows your photo, name and company on one side, and your CLA rep's photo, name and phone number on the other, with \"Prepared with C.L.A. Title & Escrow\". It also prints. Until someone adds a photo, a plain placeholder shows." },
  { t: "img", f: "calc-cobrand.png", cap: "The bar with your details and your rep's.", alt: "Calculator header with client and rep photo bar" },
  { t: "h3", x: "A special rate" },
  { t: "p", x: "Sometimes CLA has arranged a special rate for you. When that is the case, the CLA fees list shows a lower settlement fee with a short note beside it, such as \"(special rate, standard $1,075.00)\". It is already counted in your total and you do not need to do anything. Printed, copied and saved quotes show the amount without the note. If you have a question about your rate, ask your CLA rep." },
  { t: "img", f: "calc-special-fees.png", cap: "A settlement fee with the special rate note (sample data).", alt: "CLA fees list with a special rate note" },
]);

sec("profile", 5, "Your profile and photo", "Open your name in the top bar, or choose Edit profile and photo on your quotes page.", [
  { t: "ul", items: [
    "First and last name are required. Add your company so quotes carry your details.",
    "Phone, company phone, company address, website and license / NMLS number are optional and print on your quotes.",
    "Your cell phone is optional. It must be a US number, for example (240) 555-0142, and your CLA rep can see it.",
    "To change the email you sign in with, contact CLA.",
  ] },
  { t: "p", x: "A photo is optional. Use a JPEG or PNG up to 2 MB. The portal crops it to a centered square and shrinks it to 512 pixels. iPhone HEIC photos are not accepted yet: take a screenshot of the photo or save it as a JPEG first. Choose Choose photo, then Upload this photo. Choose Remove photo to go back to the placeholder." },
  { t: "img", f: "profile.png", cap: "The photo box on your profile page.", alt: "Profile photo box" },
  { t: "img", f: "profile-company.png", cap: "The company details on your profile page.", alt: "Profile company details" },
]);

sec("your-rep", 6, "Your CLA rep", "The rep CLA has matched you with is your first call for any question about a quote.", [
  { t: "ul", items: [
    "Your quotes page has a My CLA rep box with your rep's name, photo, cell phone (tap it on a phone to call), office phone and email address (click it to write an email).",
    "Your rep's name and number also print on your quotes.",
    "If the box says you have not been matched to a CLA rep yet, your quotes still save, and CLA will connect you by email.",
  ] },
]);

sec("tour", 7, "The guided tour", "A short click-through in John's voice, about a minute long.", [
  { t: "ul", items: [
    "On your quotes page it starts by itself the first time you arrive after finishing your profile. Replay it any time with Take the tour in the top bar.",
    "The calculator has its own tour, for anyone, signed in or not. Use Take the tour in the calculator header, or the \"New here?\" note.",
    "Choose Next and Back to move, or Skip tour to stop. You can close it with Esc.",
  ] },
  { t: "img", f: "tour-client-step3.png", cap: "A tour step on your quotes page.", alt: "Guided tour popup over the quotes page" },
  { t: "img", f: "tour-client-rep.png", cap: "The tour also points out where to find your rep.", alt: "Guided tour popup about your CLA rep" },
  { t: "img", f: "tour-calculator.png", cap: "The calculator tour works the same way.", alt: "Calculator guided tour step" },
]);

sec("faq", 8, "Questions and answers", "Quick fixes for the common problems. If nothing here helps, call or email your CLA rep.", [
  { t: "table", cols: ["Problem", "What to try"], rows: [
    ["I can't sign in", "Use the exact email address CLA invited. There is no public sign-up. Check your password, then choose Forgot password? on the sign-in page."],
    ["My link expired or says it was already used", "Links last 24 hours. On the sign-in page choose Forgot password? to get a fresh link."],
    ["The reset email didn't arrive", "The page gives the same message whether or not the email is on file. Check your spam folder, wait a minute and try again, and make sure you typed the address CLA invited."],
    ["I can't see a quote", "Quotes delete themselves 30 days after they were created, or you may have deleted it. Make sure you are signed in with the same email you used to run it. Run a new quote and it will save."],
    ["The quote didn't save", "Check that the note under the buttons says \"Saved to your account\". If it says it could not save, sign in again and retry. What you see on screen is still fine to print or copy."],
    ["My quote looks wrong", "Check the ZIP and county, the transaction type, who pays the owner's policy, TRID versus actual split, the first-time buyer and principal residence boxes, the document counts, and any yellow warnings. Choose Reload team sheet. It is still only an estimate, so ask your CLA rep for a binding quote."],
    ["I don't see a special rate", "Not every quote has one. Ask your CLA rep, then refresh the calculator while signed in."],
    ["My photo won't upload", "Use a JPEG or PNG up to 2 MB. iPhone HEIC photos are not accepted yet."],
    ["The phone number is rejected", "Use a US number, for example (240) 555-0142."],
    ["I don't have a rep on my page", "Your quotes still save. CLA will connect you by email."],
    ["How do I see the tour again?", "Choose Take the tour in the top bar."],
    ["I can't use the page I opened", "Choose Dashboard in the top bar to go back to your quotes."],
  ] },
]);

sec("glossary", 9, "Glossary", "Plain-English meanings for the terms you will see.", [
  { t: "table", cols: ["Term", "Meaning"], rows: [
    ["Owner's policy", "Title insurance that protects the buyer's ownership."],
    ["Lender's policy", "Title insurance that protects the lender's loan."],
    ["Simultaneous issue", "Buying both policies at once, which usually lowers the lender's premium."],
    ["Endorsement", "An add-on that extends a policy's coverage."],
    ["Reissue rate", "A lower premium when a policy on the property already exists."],
    ["Settlement fee", "CLA's fee for handling the closing."],
    ["Recording fee", "What the county charges to record a document in the land records."],
    ["Transfer tax, recordation tax", "Taxes paid to the state or county when ownership or a loan is recorded."],
    ["Deed, Deed of Trust, Release", "The documents recorded for a sale, for a loan, and for paying off a loan."],
    ["Power of attorney", "A document that lets someone sign for another person."],
    ["TRID, Loan Estimate, Closing Disclosure", "The federal rules and lender forms that show closing costs."],
    ["CPL", "Closing protection letter, a lender-required assurance about the closing agent."],
    ["Underwriter", "The insurance company that issues the title policy."],
    ["Promulgated rates", "Rates set by the state (Florida) rather than by the company."],
    ["Proration", "Splitting a recurring cost, such as property tax, by days between seller and buyer."],
    ["Payoff", "The amount needed to close out an existing loan."],
    ["HELOC", "Home equity line of credit."],
    ["Concession", "A credit the seller gives the buyer."],
    ["Net sheet", "An estimate of what the seller walks away with."],
    ["Principal residence", "The home the owner lives in as a main home."],
    ["Title search, abstract", "Research into the property's ownership and any claims against it."],
    ["E-recording", "Recording documents electronically."],
  ] },
]);

module.exports = { S };
