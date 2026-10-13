import { type PostSpec, photo, post } from "../post-spec.ts";

export const BUSINESS: PostSpec[] = [
  post(
    "mrr",
    "Month 14: $2,180 a month in recurring revenue. Nothing went viral. What worked was answering every support email within the hour and shipping what the third person asked for.",
    "business",
    "discussion",
    [],
    { key: "kept-copy" },
  ),
  post(
    "aso",
    "App Store search basics that still hold: the first three words of the title carry most of the weight, the subtitle is indexed, and the keyword field should repeat neither.",
    "business",
    "tip",
    ["aso"],
  ),
  post(
    "paywall",
    'Paywall copy test: "Start free trial" lost to "Try 7 days free" by 11%. Say the number.',
    "business",
    "tip",
    ["paywall"],
  ),
  post(
    "lena",
    "Our sign-up form had six fields. We cut it to the email address and asked the rest on day three. Completion went from 31% to 58%, and the answers on day three were better.",
    "business",
    "tip",
  ),
  post(
    "aso",
    "Screenshots before and after. Same app. The second set says what the app does in five words an image.",
    "business",
    "showcase",
    ["app-screenshots", "aso"],
    {
      media: [
        photo(
          "Five store screenshots crowded with small interface text and no captions.",
          1242,
          2208,
        ),
        photo(
          "The same five screens, each under a caption of four or five large words.",
          1242,
          2208,
        ),
      ],
    },
  ),
  post(
    "mrr",
    "The test I put an app idea through: can I find ten people complaining about this problem in public, this month, in their own words? If not, I am the only customer.",
    "business",
    "tip",
    ["app-ideas"],
  ),
  post(
    "lena",
    "Wrote down our whole onboarding sequence: five emails, what each is for, and the one we deleted because all it did was make people unsubscribe. https://counting-signups.example/onboarding",
    "business",
    "guide",
    [],
    {
      card: {
        title: "Five onboarding emails and the one we deleted",
        description:
          "Subject lines, send times, what each is meant to get the reader to do, and the numbers.",
      },
    },
  ),
  post(
    "paywall",
    'Annual plans: show what the annual plan costs a month, not the yearly total. "$4.16 a month, billed yearly" outsold "$49.99 a year" in every test I ran.',
    "business",
    "tip",
    ["paywall"],
  ),
  post(
    "emir",
    "Uygulama fikri ararken kendime sorduğum tek soru: bu sorunu geçen ay yaşamış on kişi bulabiliyor muyum? Bulamıyorsam elimdeki fikir değil, tahmin.",
    "business",
    "tip",
    ["app-ideas"],
    { lang: "tr" },
  ),
  post(
    "lena",
    'SEO for a small product: write the comparison page yourself. "This versus that" is typed by people with a credit card in their hand.',
    "business",
    "tip",
    ["seo"],
  ),
  post(
    "mrr",
    "Ran ads for two weeks. $600 in, 9 customers out, 2 still paying a month later. Paused. One useful article a week has beaten that every month since.",
    "business",
    "discussion",
    ["ads", "seo"],
  ),
  post(
    "paywall",
    "Hard paywall or soft: for a utility people need once, hard. For a habit they are building, soft. We guessed wrong twice before we measured.",
    "business",
    "discussion",
    ["paywall"],
  ),
  post(
    "aso",
    "Localising the store listing into five languages took an afternoon and added 22% to impressions. Begin with the title, the subtitle and the first two screenshots.",
    "business",
    "tip",
    ["aso", "app-screenshots"],
  ),
  post(
    "lena",
    "Churn interviews: the reason people give for cancelling is the last thing that annoyed them, not the reason. Ask what they are using instead.",
    "business",
    "tip",
  ),
  post(
    "mrr",
    "Forming the company took two weeks. Choosing its name took four. Pick anything. Nobody reads the legal name.",
    "business",
    "discussion",
  ),
  post(
    "paywall",
    "Published our library of paywall teardowns: 60 paywalls from subscription apps, sorted by layout, by length of trial, and by where the close button hides. https://paywall-experiments.example/library",
    "business",
    "resource-list",
    ["paywall"],
    {
      card: {
        title: "Sixty paywalls, taken apart",
        description:
          "Each with its layout, its offer, its trial and the one thing it does that the others do not.",
      },
    },
  ),
  post(
    "aso",
    "When to ask for a rating: after the user finishes the thing the app is for, the third time they finish it. Never at launch.",
    "business",
    "tip",
    ["aso"],
  ),
  post(
    "lena",
    "A pricing page needs three things before the first scroll: who it is for, what it costs, and the button. The feature table is for people who have already decided.",
    "business",
    "tip",
  ),
  post(
    "mrr",
    'Same here. Asking "what are you using instead" got me my two best feature ideas.',
    "business",
    "discussion",
    [],
    { replyTo: "lena" },
  ),
  post(
    "paywall",
    "Refund requests fell by half when the reminder that a trial is ending went out two days early, with a way to cancel in one tap. Revenue did not move.",
    "business",
    "tip",
    ["paywall"],
  ),
  post(
    "aso",
    "A keyword routine that takes an hour a month.\n\nFirst week: write down the twenty phrases a stranger would type to find an app like yours. Not your features, their problem. Second week: look each one up and note who ranks in the top five and how many ratings they have. A phrase where the fifth result has under a hundred ratings is one you can win. Third week: put the three best of those into the title and subtitle, and the next ten into the keyword field, each word once. Fourth week: do nothing. Rankings need about three weeks to settle, and changing the listing again before then tells you only that you are impatient.\n\nThen compare impressions with the month before and repeat with the phrases you did not use.",
    "business",
    "guide",
    ["aso"],
  ),
  post(
    "lena",
    "Honest numbers on growing through social posts: 4,000 followers gained in a year of posting daily, and 60 customers traced to it. Worth it for the conversations, not as a funnel.",
    "business",
    "discussion",
  ),
];
