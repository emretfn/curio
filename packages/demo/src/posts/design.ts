import { gif, type PostSpec, photo, post } from "../post-spec.ts";

export const DESIGN: PostSpec[] = [
  post(
    "noor",
    "Shadows: two layers, not one. A tight dark one for contact and a wide soft one for height. A single big blurry shadow is why your cards look as if they were floating in fog.",
    "design",
    "tip",
    ["ui-components"],
  ),
  post(
    "kerning",
    "If one screen uses more than three font sizes, size is doing all the work of the hierarchy. Try weight and colour first.",
    "design",
    "tip",
  ),
  post(
    "elif",
    "Boşluk bir tasarım öğesidir. İlgili şeyleri yaklaştırın, ilgisizleri uzaklaştırın. Çizgi ve kutu eklemeden önce aradaki mesafeyi değiştirmeyi deneyin.",
    "design",
    "tip",
    [],
    { lang: "tr" },
  ),
  post(
    "easing",
    "A spring with no bounce is still a spring. It just stops the way a real thing stops.",
    "design",
    "showcase",
    ["animation"],
    {
      media: [
        gif(
          "A square crosses the frame three times: at a constant speed, easing out, and on a critically damped spring.",
        ),
      ],
    },
  ),
  post(
    "noor",
    "Where I look when a layout will not come: old print magazines, transit maps, hardware manuals, and the settings screens of apps that have been around for ten years. https://pixel-by-pixel.example/references",
    "design",
    "resource-list",
    [],
    {
      card: {
        title: "A shelf of references that are not interfaces",
        description:
          "Timetables, instrument panels, field guides and forms: where dense information was solved before screens.",
      },
    },
  ),
  post(
    "kerning",
    "Tabular numbers. If a number changes while someone is watching it (a timer, a price, a count), its digits must not shift sideways. `font-variant-numeric: tabular-nums`.",
    "design",
    "tip",
    ["css"],
  ),
  post(
    "easing",
    "Easing in four lines: ease-out for what enters, ease-in for what leaves for good, ease-in-out for what moves from one place on screen to another, and linear for progress bars and nothing else.",
    "design",
    "guide",
    ["animation"],
  ),
  post(
    "noor",
    "New: 120 interface icons drawn on a 20 px grid with a 1.5 px stroke, under an open licence. I made them because every set I tried had its own idea of what a corner is. https://pixel-by-pixel.example/icons",
    "design",
    "launch",
    ["open-source", "ui-components"],
    {
      card: {
        title: "120 icons, one idea of a corner",
        description:
          "A 20 px grid, a 1.5 px stroke, and the same radius on every bend. Free to use and to change.",
      },
    },
  ),
  post(
    "elif",
    "Tasarım sisteminde ilk kural: rengin adı ne olduğunu değil, ne işe yaradığını söylesin. `mavi-500` değil `vurgu`. Karanlık temayı eklediğiniz gün kendinize teşekkür edersiniz.",
    "design",
    "tip",
    [],
    { lang: "tr" },
  ),
  post(
    "kerning",
    "Most dark modes are the light mode turned upside down, and it shows. Dark surfaces want less contrast between layers and more between text and surface, not the same ratios inverted.",
    "design",
    "discussion",
  ),
  post(
    "focus",
    "Colour contrast is the easy part of accessible design. The hard part is the order things are read in. Tab through your page with your eyes closed and listen.",
    "design",
    "tip",
    ["accessibility"],
  ),
  post(
    "noor",
    "Redesigned the empty states. Each one says what belongs here, how it gets here, and offers the one action that starts it.",
    "design",
    "showcase",
    ["ui-components"],
    {
      media: [
        photo(
          "An empty inbox screen: a line of text, a sentence beneath it, and a single button.",
        ),
        photo(
          "An empty search result: the query repeated, and two suggestions for widening it.",
        ),
        photo(
          "An empty project list with a short explanation and a button to create the first project.",
        ),
      ],
    },
  ),
  post(
    "easing",
    "The best animation in most products is the one on a button press: scale to 0.97 over 100 ms. It tells your finger the screen heard it.",
    "design",
    "tip",
    ["animation"],
  ),
  post(
    "kerning",
    "Line length: 45 to 75 characters. Your blog is not hard to read because of the typeface. It is hard to read because the paragraph is 140 characters wide.",
    "design",
    "tip",
  ),
  post(
    "noor",
    "Wrote a long one on designing for density.",
    "design",
    "guide",
    [],
    {
      article: {
        title: "Dense is not cluttered",
        preview:
          "Professional tools show a great deal at once, and the people who use them like it that way. Density works when alignment is strict, type is small but not light, and the eye always has a column to follow.",
      },
    },
  ),
  post(
    "okan",
    "Uygulama ikonunu yapay zekâyla üretmeyi denedim. On denemeden biri işe yarıyor: tek renk ve tek şekil istediğim.",
    "design",
    "showcase",
    ["image-generation"],
    {
      lang: "tr",
      media: [
        photo(
          "Dört uygulama ikonu denemesi. Yalnızca sonuncusu sade: koyu zemin üzerinde tek bir beyaz yaprak.",
          1200,
          1200,
        ),
      ],
    },
  ),
  post(
    "easing",
    "Motion references I go back to: a visualiser for springs, a gallery of small interactions sorted by duration, and a talk on animation that can be interrupted. https://easing-daily.example/shelf",
    "design",
    "resource-list",
    ["animation"],
    {
      card: {
        title: "The motion shelf",
        description:
          "Three references and what each is good for, kept short on purpose.",
      },
    },
  ),
  post(
    "kerning",
    "Stop centring long text. Centre one line, perhaps two. Anything longer needs a left edge for the eye to return to.",
    "design",
    "tip",
  ),
  post(
    "noor",
    "A good loading state has the shape of what is coming. A spinner tells you nothing. Three grey lines where the text will be tell you it will be text.",
    "design",
    "tip",
    ["ui-components"],
  ),
  post(
    "elif",
    "Figma'da bana en çok zaman kazandıran kısayol: Shift + A ile otomatik yerleşim. Seç, bas, bitti. Elle hizalamayı bıraktığımdan beri dosyalarım dağılmıyor.",
    "design",
    "tip",
    [],
    { lang: "tr", proposed: ["figma"] },
  ),
  post(
    "easing",
    "Reduced motion does not mean no motion. It means nothing travels across the screen. A fade is fine. Take out every transition and changes of state become invisible.",
    "design",
    "discussion",
    ["animation", "accessibility"],
  ),
  post(
    "kerning",
    "Yes. And the fix is rarely a new typeface.",
    "design",
    "discussion",
    [],
    {
      quote: {
        by: "noor",
        text: "Changed nothing but the line height and the letter spacing of the headings. The client asked which new font we had bought.",
      },
    },
  ),
  post(
    "focus",
    "Target size: 44 by 44 points, even when the icon is 16. The padding is part of the button.",
    "design",
    "tip",
    ["accessibility"],
  ),
];
