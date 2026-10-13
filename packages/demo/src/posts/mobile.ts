import { type PostSpec, post, video } from "../post-spec.ts";

export const MOBILE: PostSpec[] = [
  post(
    "yusuf",
    "First rule of SwiftUI performance: `body` is called more often than you think. Keep it cheap, and move anything that allocates out of it.",
    "mobile-dev",
    "tip",
    ["swiftui"],
  ),
  post(
    "swiftui",
    "`@Observable` cut our view models in half. No `@Published` on every property, and a view is drawn again only for the properties it actually reads.",
    "mobile-dev",
    "tip",
    ["swiftui"],
  ),
  post(
    "ines",
    "File-based routing finally made deep links boring. The file is the route, the route is the link, and the link opens the right screen from a cold start.",
    "mobile-dev",
    "discussion",
    ["react-native"],
  ),
  post(
    "yusuf",
    "Fourth rejection from App Review this year: the screenshots showed a feature that sits behind the paywall without saying so. Label paid features in your screenshots.",
    "mobile-dev",
    "tip",
    ["app-screenshots", "paywall"],
  ),
  post(
    "swiftui",
    "Custom layouts with the `Layout` protocol are less frightening than they look: two methods, one that measures and one that places. I rebuilt a flow layout in forty lines.",
    "mobile-dev",
    "tip",
    ["swiftui"],
  ),
  post(
    "ines",
    "Notes from moving to React Native's new architecture: most of the work was replacing three old native modules. The app itself needed almost nothing.",
    "mobile-dev",
    "discussion",
    ["react-native"],
  ),
  post(
    "yusuf",
    "Released my haptics helper for SwiftUI as a package: one modifier, named patterns, and it respects the system setting. https://indie-ios.example/haptics",
    "mobile-dev",
    "launch",
    ["swiftui", "open-source"],
    {
      card: {
        title: "Haptics as one modifier",
        description:
          "Named patterns for success, warning and selection, silent when the system says so.",
      },
    },
  ),
  post(
    "swiftui",
    "A lesson in Swift concurrency: an actor protects its state, not your assumptions. Between two awaits anything may have changed. Check again after every suspension.",
    "mobile-dev",
    "tip",
  ),
  post(
    "ines",
    "Over-the-air updates saved a launch: a typo in the price on the paywall, fixed for everyone in ten minutes with no review. JavaScript only, though. A native change still waits.",
    "mobile-dev",
    "discussion",
    ["react-native", "paywall"],
  ),
  post(
    "yusuf",
    'TestFlight tip: put what you want testers to try in "What to Test", as three numbered steps. The feedback goes from "looks good" to actual bugs.',
    "mobile-dev",
    "tip",
    [],
    { proposed: ["testflight"] },
  ),
  post(
    "swiftui",
    "A sheet with detents that follows your finger and can be caught in mid-flight. This is what an interactive spring is for.",
    "mobile-dev",
    "showcase",
    ["swiftui", "animation"],
    {
      media: [
        video(
          12,
          "A bottom sheet dragged between three heights. Released halfway, it settles on the nearest one; grabbed again while moving, it follows the finger at once.",
        ),
      ],
    },
  ),
  post(
    "ines",
    "What I add to every Expo project on the first day: navigation, a list that virtualises properly, secure storage, an image component that caches, and a keyboard helper that works. https://ships-with-expo.example/day-one",
    "mobile-dev",
    "resource-list",
    ["react-native"],
    {
      card: {
        title: "Day one: five libraries",
        description:
          "What each replaces, and the setting in each that I change before writing any code.",
      },
    },
  ),
  post(
    "yusuf",
    "Xcode build times: turned on the build timeline and found one file that took 9 seconds to type-check because of a long chained expression. Split it into three constants. Done.",
    "mobile-dev",
    "tip",
    [],
    { proposed: ["xcode"] },
  ),
  post(
    "swiftui",
    "SwiftData is fine for a notes app and not yet for anything with sync conflicts. I went back to SQLite behind a thin wrapper and slept better.",
    "mobile-dev",
    "discussion",
    ["swiftui", "sqlite"],
  ),
  post(
    "zeynep",
    "Expo ile ilk uygulamamı mağazaya gönderdim. En uzun süren kod değil, ekran görüntüleriydi. Önce ekran görüntülerini tasarlayın, sonra uygulamayı yazın.",
    "mobile-dev",
    "discussion",
    ["react-native", "app-screenshots"],
    { lang: "tr" },
  ),
  post(
    "yusuf",
    "Uploads to App Store Connect from a ten-line script: build, sign, upload, and take the release notes from the changelog. Releasing stopped being an event.",
    "mobile-dev",
    "tip",
    [],
    { proposed: ["app-store-connect"] },
  ),
  post(
    "swiftui",
    "Accessibility in SwiftUI is mostly free while you use real controls. The day you draw a button out of a rectangle and a tap gesture, you owe it a label, a trait and a hint.",
    "mobile-dev",
    "tip",
    ["swiftui", "accessibility"],
  ),
  post(
    "ines",
    "List performance in React Native: stable keys, memoised rows, fixed heights where you can. The clever list library helps only after those three.",
    "mobile-dev",
    "tip",
    ["react-native"],
  ),
  post(
    "yusuf",
    "This. My widget is used more than my app.",
    "mobile-dev",
    "discussion",
    ["swiftui"],
    {
      quote: {
        by: "swiftui",
        text: "Widgets and Live Activities are your app's real home screen now. Design them first.",
      },
    },
  ),
  post(
    "ines",
    "Permission for notifications: ask after the user does something a notification would help with. Ask at first launch and you get a no that you may not ask about again.",
    "mobile-dev",
    "tip",
    ["react-native"],
  ),
  post(
    "swiftui",
    "Previews that load at once: give each view a small struct of plain data, and a preview with three versions of it: empty, typical, and absurdly long.",
    "mobile-dev",
    "tip",
    ["swiftui"],
  ),
  post(
    "yusuf",
    'Shipped version 3.0. Four months of work, and the review that made my week says: "it opens faster now".',
    "mobile-dev",
    "discussion",
  ),
];
