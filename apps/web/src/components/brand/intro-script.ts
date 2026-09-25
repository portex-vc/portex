/*
  Runs in <head> before first paint and decides whether the first-visit intro plays (DESIGN_V2 §4).

  Deliberately a plain module, not a "use client" one: the root layout is a server component, and a
  value imported from a client module reaches the browser as a lazy client reference. Inside <head>
  that reference makes hydration suspend and re-enter the head, which leaves React's hydration cursor
  in <head> and fails the first <body> element intermittently (React error #418).
*/
export const INTRO_SCRIPT = `(function(){var d=document.documentElement;try{var skip=sessionStorage.getItem("portex-intro")||navigator.webdriver||matchMedia("(prefers-reduced-motion: reduce)").matches;d.setAttribute("data-intro",skip?"skip":"play");if(!skip)sessionStorage.setItem("portex-intro","1")}catch(e){d.setAttribute("data-intro","skip")}})();`;
