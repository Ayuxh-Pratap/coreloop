/**
 * Example skills for the simulated desktop: what a desktop surface could declare for the apps on day 1 and day 2,
 * as plain data (templates, slot kinds, risk): they survive JSON, as a surface would send them. They exist so
 * the core can be tested, evaluated and demonstrated with real-looking apps. How each action is carried out on a
 * real machine belongs to that surface (the `windows` branch has the Windows executors: spotify_cli, browser
 * exes, Win32 keys).
 */
import type { Skill, SkillAction } from "../skills/types.ts";

/** An action that only sends keys to its app: the surface brings the app to the front first. */
const keys = (id: string, label: string, what: string, templates: string[], risk: SkillAction["risk"] = "safe"): SkillAction => ({ id, label, what, risk, templates });

// ---------------------------------------------------------------- Spotify

const PLAY_MUSIC = [
  { t: "play [me] [the] (song|track) {query}", set: { kind: "track" } },
  { t: "play [me] [the|my] playlist {query}", set: { kind: "playlist" } },
  { t: "play [me] [the] album {query}", set: { kind: "album" } },
  "play [me] [some|any|a|a few] [song|songs|track|tracks|music] (by|of|from) {query}",
  "play [me] {query} (song|songs|track|tracks|music)",
  "[we|let's|can you] (change|switch) the (song|track|music) * to [any|some|a|the] [song|songs|track|tracks|music] [by|of|from] {query}",
];

const OPEN_ARTIST = [
  // first: "open the artist profile" is the artist just searched for, not an artist called "profile"
  { t: "(open|go to|show|show me|take me to|click on|click) [the|this|that|his|her|their|its] (artist|artist profile|artist page|profile)", set: { query: "@here" } },
  "(open|go to|show|show me|take me to|click on|click) [the] [artist] (profile|page) (of|for) {query}",
  "(open|go to|show|show me|take me to|click on|click) [the] artist {query}",
  "(open|go to|show|show me|take me to|click on|click) {query} (profile|page|artist page|artist profile)",
];

/** What Spotify's things are called: "its songs", "this artist", "some music" name no song. */
const MUSIC_NOUNS = ["music", "song", "songs", "track", "tracks", "tune", "tunes", "audio", "sound", "album", "artist", "stuff"];

const PLAY_RESULT = ["play [the] {choice} (song|track|result|one|video|item) *", "play (song|track|result) [number] {choice} *"];

export const spotify: Skill = {
  id: "spotify",
  places: ["Spotify"],
  actions: [
    {
      id: "spotify.play_result",
      label: "play a song from the last search",
      what: "play the first, second or third song from the last spotify search (play the first song)",
      risk: "safe",
      templates: PLAY_RESULT,
      ambient: PLAY_RESULT,
      shows: false,
      does: 'play the {choice} song of "{query}" on Spotify',
      slots: { choice: "position" },
      usesLastSearch: true,
    },
    {
      id: "spotify.play",
      label: "play something on Spotify",
      what: "play an artist, song or playlist on spotify (play panther, change the song to radiohead)",
      risk: "safe",
      templates: [...PLAY_MUSIC, "(put on|play|queue up|start playing) {query}"],
      anywhere: ["play [me] [some|any|a] [song|songs|track|tracks|music] [by|of|from] {query} (on|in|using) spotify"],
      ambient: PLAY_MUSIC,
      shows: false,
      does: 'play "{query}" on Spotify',
      slots: { query: "name" },
      nouns: MUSIC_NOUNS,
      example: '"play Panther on Spotify"',
    },
    {
      id: "spotify.open_artist",
      label: "open an artist's page",
      what: "open an artist's page in spotify (open panther's profile, go to the artist page)",
      risk: "safe",
      templates: OPEN_ARTIST,
      ambient: OPEN_ARTIST,
      does: 'open the Spotify page of "{query}"',
      slots: { query: "name" },
      nouns: MUSIC_NOUNS,
      example: '"open Panther\'s profile"',
    },
    {
      id: "spotify.search",
      label: "search in Spotify",
      what: "search inside spotify and show the results (search for panther, find radiohead)",
      risk: "safe",
      templates: ["search [spotify] [for] {query}", "(look up|look for|find) {query}"],
      anywhere: ["search spotify for {query}"],
      does: 'search Spotify for "{query}"',
      slots: { query: "name" },
      nouns: MUSIC_NOUNS,
      example: '"search for Panther on Spotify"',
    },
    {
      id: "spotify.like",
      label: "like this song",
      what: "save the song that is playing to liked songs (like this song, save this track)",
      risk: "safe",
      templates: ["(like|save|heart|love) [this|the|that|current] [song|track|one]", "add [this|the|that|current] [song|track] to [my] (library|liked songs|likes)"],
      ambient: ["(like|save|heart) this (song|track)", "add this (song|track) to [my] (library|liked songs|likes)"],
      shows: false,
      does: "like the song that's playing",
    },
    {
      id: "spotify.now_playing",
      label: "say what's playing",
      what: "say which song is playing (what's playing, what song is this)",
      risk: "safe",
      templates: ["what's [this|that] [song|track|playing]", "what is [this|that] [song|track|playing]", "what (song|track) is [this|that|playing]", "what's playing [now|right now]"],
      shows: false,
      does: "show what's playing",
    },
  ],
};

// ---------------------------------------------------------------- browsers

export const browser: Skill = {
  id: "browser",
  places: ["Brave", "Google Chrome", "Microsoft Edge"],
  actions: [
    {
      id: "browser.search",
      label: "search in this browser",
      what: "search the web in this browser (search for panther, google the weather)",
      risk: "safe",
      templates: ["search [the web|online|google|the internet] [for] {query}", "(google|look up|look for|find) {query}"],
      does: 'search {app} for "{query}"',
      slots: { query: "search" },
      example: '"search for Panther on Brave"',
    },
    {
      id: "browser.open_site",
      label: "open a website in this browser",
      what: "open a website in this browser (open youtube, go to github dot com)",
      risk: "safe",
      templates: ["(open|go to|visit|load|show me) {query}"],
      does: "open {url} in {app}",
      slots: { query: "site" },
    },
    keys("browser.tab_new", "open a new tab", "open a new tab (new tab, open a tab)", ["[open|create|make|give me] [a] new tab", "open a tab"]),
    keys("browser.tab_close", "close this tab", "close the current tab (close this tab)", ["(close|shut) [this|the|that|current] tab"], "confirm"),
    keys("browser.tab_reopen", "reopen the last closed tab", "reopen the tab that was just closed (reopen that tab, bring back the tab)", ["(reopen|restore|bring back|undo close) [the|that] [last] [closed] tab"]),
    keys("browser.tab_next", "go to the next tab", "switch to the next tab (next tab)", ["[go to|switch to] [the] next tab", "next tab"]),
    keys("browser.tab_previous", "go to the previous tab", "switch to the previous tab (previous tab, last tab)", ["[go to|switch to] [the] (previous|last) tab", "(previous|last) tab"]),
    keys("browser.back", "go back a page", "go back to the previous page (go back, back)", ["[go] back [a page|one page]", "previous page"]),
    keys("browser.forward", "go forward a page", "go forward a page (go forward)", ["[go] forward [a page|one page]", "next page"]),
    keys("browser.reload", "reload the page", "reload the page (refresh, reload this page)", ["(reload|refresh) [the|this] [page|tab|site]"]),
  ],
};

// ---------------------------------------------------------------- terminal, Claude, Cursor

export const terminal: Skill = {
  id: "terminal",
  places: ["Terminal"],
  actions: [
    { ...keys("terminal.tab_new", "open a new terminal tab", "open a new terminal tab (new tab, open a tab)", ["[open|create|make|give me] [a] new tab", "open a tab"]), does: "open a new Terminal tab" },
    {
      id: "terminal.split",
      label: "split the terminal",
      what: "split the terminal into two panes (split the pane, split it down)",
      risk: "safe",
      does: "split the Terminal",
      templates: [
        { t: "split [the|this] [pane|window|terminal|screen|tab] (down|horizontally|below)", set: { kind: "down" } },
        "split [the|this] [pane|window|terminal|screen|tab] [right|vertically|sideways|in two|in half]",
      ],
    },
    keys("terminal.tab_next", "go to the next tab", "switch to the next terminal tab (next tab)", ["[go to|switch to] [the] next tab", "next tab"]),
    keys("terminal.tab_previous", "go to the previous tab", "switch to the previous terminal tab (previous tab)", ["[go to|switch to] [the] (previous|last) tab", "(previous|last) tab"]),
    keys("terminal.tab_close", "close this tab", "close the current terminal tab (close this tab)", ["(close|shut) [this|the|that|current] tab"], "confirm"),
  ],
};

/** "paste X into claude code", "ask claude code in the terminal to X": the user's words into Claude Code, not sent. */
const INTO = "(paste|put|send|type|write|give) [in] {span} (into|to|in|on) claude [code]";
const ASK = "(ask|tell|have|get) claude [code]";

export const claude: Skill = {
  id: "claude",
  places: ["Claude"],
  actions: [
    {
      id: "claude.prompt",
      label: "put your words into Claude Code",
      what: "put the user's words into Claude Code (paste fix the tests into claude code)",
      risk: "fill",
      offer: "always",
      templates: [],
      anywhere: [
        // the terminal first, so "claude code terminal" never reads as the app
        { t: `${INTO} (terminal|cli)`, set: { claude_target: "terminal" } },
        { t: `${INTO} [app|desktop] (in|on) the terminal`, set: { claude_target: "terminal" } },
        { t: `${ASK} (terminal|cli) to {span}`, set: { claude_target: "terminal" } },
        { t: `${ASK} (in|on) the terminal to {span}`, set: { claude_target: "terminal" } },
        { t: `${INTO} [app|desktop] [in the app|on the app]`, set: { claude_target: "app" } },
        { t: `${ASK} [app|desktop] [in the app|on the app] to {span}`, set: { claude_target: "app" } },
      ],
      // too loose to decide on their own; only once the model picked this action
      afterModel: [
        { t: "claude [code] (terminal|cli) {span}", set: { claude_target: "terminal" } },
        { t: "claude [code] (in|on) the terminal {span}", set: { claude_target: "terminal" } },
        { t: "claude [code] [app|desktop] {span}", set: { claude_target: "app" } },
      ],
      example: '"ask Claude Code to fix the tests"',
      shows: false,
    },
    keys("claude.new_chat", "start a new chat", "start a new chat in claude (new chat, new conversation)", [
      "[open|start|create|make|begin] [a] new (chat|conversation|session|thread)",
      "new (chat|conversation)",
    ]),
  ],
};

export const cursor: Skill = {
  id: "cursor",
  places: ["Cursor"],
  actions: [
    {
      id: "cursor.chat",
      label: "put words into Cursor's chat",
      what: "put the user's words into cursor's ai chat (ask cursor to fix the tests)",
      risk: "fill",
      does: 'open Cursor\'s chat and paste "{span}" (not sent)',
      templates: ["(ask|tell) (cursor|the agent|the ai|the chat|composer) [to] {span}"],
      anywhere: ["(ask|tell) cursor [to] {span}", "(paste|put|send|type) {span} (in|into|to) [the] cursor (chat|agent)"],
      example: '"ask Cursor to fix the tests"',
    },
    keys("cursor.open_chat", "open Cursor's chat", "open the ai chat panel in cursor (open the chat, show the agent)", ["(open|show|toggle) [the] (chat|agent|ai|composer) [panel|pane|window]"]),
    keys("cursor.palette", "open the command palette", "open the command palette (command palette)", ["[open|show] [the] command palette"]),
    keys("cursor.new_window", "open a new Cursor window", "open a new cursor window (new window)", ["[open|create] [a] new window"]),
    keys("cursor.terminal", "show Cursor's terminal", "show or hide the terminal panel inside cursor (toggle the terminal)", ["(show|toggle|hide) [the] [integrated] terminal [panel]"]),
    {
      id: "cursor.find_file",
      label: "find a file in Cursor",
      what: "find a file by name in cursor (open the file parser, go to file app dot tsx)",
      risk: "fill",
      templates: ["(find|go to|open|search for) [the] file [called|named] {span}"],
      does: 'look for the file "{span}" in Cursor',
      example: '"find the file parser"',
    },
  ],
};

// ---------------------------------------------------------------- messaging

const FIND_CHAT_DOES = 'look for the chat "{query}" in {app}';
const FIND_CHAT = ["(find|search for|search|look for|look up|open|go to) [the] [chat|conversation] [with|for] {query}", "(message|chat with|talk to) {query}"];

export const telegram: Skill = {
  id: "telegram",
  places: ["Telegram"],
  actions: [
    {
      id: "telegram.find_chat",
      label: "find a chat in Telegram",
      what: "find a chat or person in telegram by name (find rahul, open the chat with mom)",
      risk: "fill",
      templates: FIND_CHAT,
      does: FIND_CHAT_DOES,
      slots: { query: "search" },
      example: '"find Rahul on Telegram"',
    },
    keys("telegram.chat_next", "go to the next chat", "go to the next chat in the list (next chat)", ["[go to|switch to|open] [the] next chat", "next chat"]),
    keys("telegram.chat_previous", "go to the previous chat", "go to the previous chat in the list (previous chat)", ["[go to|switch to|open] [the] previous chat", "previous chat"]),
    keys("telegram.saved", "open Saved Messages", "open saved messages (my saved messages)", ["[open|show|go to] [my] saved messages"]),
  ],
};

export const whatsapp: Skill = {
  id: "whatsapp",
  places: ["WhatsApp"],
  actions: [
    {
      id: "whatsapp.find_chat",
      label: "find a chat in WhatsApp",
      what: "find a chat or person in whatsapp by name (find rahul, open the chat with mom)",
      risk: "fill",
      templates: FIND_CHAT,
      does: FIND_CHAT_DOES,
      slots: { query: "search" },
      example: '"find Rahul on WhatsApp"',
    },
    keys("whatsapp.chat_next", "go to the next chat", "go to the next chat in the list (next chat)", ["[go to|switch to|open] [the] next chat", "next chat"]),
    keys("whatsapp.chat_previous", "go to the previous chat", "go to the previous chat in the list (previous chat)", ["[go to|switch to|open] [the] previous chat", "previous chat"]),
  ],
};

// ---------------------------------------------------------------- windows of any app

const IT = "(it|this|that|this window|the window|this app|that window)";
const NAMED = "[the|my] {app}";

/** An {app} names an app as a whole; with no {app} the action is for the window in use. */
const win = (id: string, label: string, what: string, templates: SkillAction["anywhere"]): SkillAction => ({ id, label, what, risk: "safe", templates: [], anywhere: templates, slots: { app: "app" }, shows: false });

export const window: Skill = {
  id: "window",
  places: [],
  actions: [
    win("window.maximize", "maximize the window", "make a window fill the screen (maximize spotify, make it full screen)", [
      `(maximize|maximise|expand|enlarge) ${NAMED}`,
      `(maximize|maximise|expand|enlarge) ${IT}`,
      `make ${NAMED} (full screen|fullscreen|bigger|big|maximized|maximised|large)`,
      `make ${IT} (full screen|fullscreen|bigger|big|maximized|maximised|large)`,
      `(full screen|fullscreen) ${NAMED}`,
      `(full screen|fullscreen) [${IT}]`,
      "[go] (full screen|fullscreen)",
    ]),
    win("window.minimize", "minimize the window", "minimize a window to the taskbar (minimize spotify, hide it)", [`(minimize|minimise|hide) ${NAMED}`, `(minimize|minimise|hide) ${IT}`]),
    win("window.restore", "restore the window", "bring a window back to its normal size (restore spotify, make it smaller)", [
      `(restore|unmaximize|unmaximise|un maximize|unminimize|un minimize) ${NAMED}`,
      `(restore|unmaximize|unmaximise|un maximize) [${IT}]`,
      `make ${NAMED} smaller`,
      `make ${IT} smaller`,
    ]),
    win("window.snap", "snap the window left or right", "snap a window to the left or right half of the screen (snap spotify left)", [
      { t: `(snap|move|put|push) ${NAMED} [to] [the] left [side|half]`, set: { kind: "left" } },
      { t: `(snap|move|put|push) ${NAMED} [to] [the] right [side|half]`, set: { kind: "right" } },
      { t: `(snap|move|put|push) ${IT} [to] [the] left [side|half]`, set: { kind: "left" } },
      { t: `(snap|move|put|push) ${IT} [to] [the] right [side|half]`, set: { kind: "right" } },
    ]),
    win("window.show_desktop", "show the desktop", "minimize everything and show the desktop (show desktop)", [
      "show [me] [the|my] desktop",
      "(minimize|minimise|hide) (everything|all [the] windows|all windows)",
      "go to [the] desktop",
    ]),
  ],
};

/** Every example skill, as the simulated desktop declares them. */
export const SIM_SKILLS: readonly Skill[] = [spotify, browser, terminal, claude, cursor, telegram, whatsapp, window];
