/**
 * The accounts the demo's posts are written under. Every one is invented for
 * the demo: a pen name of the kind people post under, never a person's full
 * name, and a handle of sixteen characters or more. X allows a handle
 * fifteen, so none of these can be an account there, now or later.
 * `demo.test.ts` holds both to that.
 */

interface AuthorSpec {
  name: string;
  handle: string;
  verified?: true;
}

export const AUTHORS = {
  selin: { name: "selin builds things", handle: "selin_builds_things" },
  kaan: { name: "Kaan, shipping slowly", handle: "kaan_ships_slowly" },
  wal: {
    name: "the WAL whisperer",
    handle: "the_wal_whisperer",
    verified: true,
  },
  tiny: {
    name: "Tiny Tools Weekly",
    handle: "tiny_tools_weekly",
    verified: true,
  },
  mert: { name: "Mert reads the docs", handle: "mert_reads_the_docs" },
  ada: { name: "ada writes parsers", handle: "ada_writes_parsers" },
  deniz: { name: "Deniz debugs at night", handle: "deniz_debugs_at_night" },
  migrations: {
    name: "Late Night Migrations",
    handle: "late_night_migrations",
  },
  noor: {
    name: "Noor, pixel by pixel",
    handle: "noor_pixel_by_pixel",
    verified: true,
  },
  kerning: { name: "Kerning Complaints Dept.", handle: "kerning_complaints" },
  yusuf: { name: "Yusuf · indie iOS", handle: "yusuf_indie_ios_dev" },
  swiftui: { name: "SwiftUI Field Notes", handle: "swiftui_field_notes" },
  ines: { name: "Ines ships with Expo", handle: "ines_ships_with_expo" },
  loop: { name: "agents in the loop", handle: "agents_in_the_loop" },
  drawer: { name: "Prompt Drawer", handle: "prompt_drawer_notes" },
  tomas: { name: "Tomás on harnesses", handle: "tomas_on_harnesses" },
  zeynep: { name: "Zeynep, kod ve kahve", handle: "zeynep_kod_ve_kahve" },
  emir: { name: "Emir yazılım notları", handle: "emir_yazilim_notlari" },
  elif: { name: "Elif tasarım defteri", handle: "elif_tasarim_defteri" },
  baris: { name: "Barış · arka uç", handle: "baris_arka_uc_notlari" },
  mrr: { name: "Small MRR Diaries", handle: "small_mrr_diaries" },
  aso: { name: "ASO After Hours", handle: "aso_after_hours_log" },
  paywall: {
    name: "Paywall Experiments",
    handle: "paywall_experiments",
    verified: true,
  },
  lena: { name: "Lena counts signups", handle: "lena_counts_signups" },
  homelab: { name: "Homelab on a Shelf", handle: "homelab_on_a_shelf" },
  dawn: {
    name: "Postgres at Dawn",
    handle: "postgres_at_dawn",
    verified: true,
  },
  edge: { name: "Only Edge Cases", handle: "only_edge_cases_here" },
  ravi: { name: "Ravi locks things down", handle: "ravi_locks_things_down" },
  terminal: { name: "Terminal Minimalist", handle: "terminal_minimalist" },
  cascade: { name: "Cascade Layer Club", handle: "cascade_layer_club" },
  jo: { name: "Jo, strictly typed", handle: "strictly_typed_jo" },
  hana: { name: "Hana renders twice", handle: "hana_renders_twice" },
  router: { name: "App Router Diaries", handle: "app_router_diaries" },
  easing: { name: "Easing Curves Daily", handle: "easing_curves_daily" },
  radar: { name: "Model Release Radar", handle: "model_release_radar" },
  okan: { name: "Okan, piksel ve prompt", handle: "okan_piksel_ve_prompt" },
  notebook: { name: "Mid-Career Notebook", handle: "mid_career_notebook" },
  skeptic: { name: "Standing Desk Skeptic", handle: "standing_desk_skeptic" },
  solder: { name: "Solder and Regret", handle: "solder_and_regret" },
  flaky: { name: "Flaky Test Hunter", handle: "flaky_test_hunter" },
  focus: { name: "Focus Ring Fan Club", handle: "focus_ring_fan_club" },
  issues: { name: "Issues Welcome", handle: "oss_issues_welcome" },
} as const satisfies Record<string, AuthorSpec>;

export type AuthorKey = keyof typeof AUTHORS;
