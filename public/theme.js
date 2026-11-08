/* =====================================
   THEME  (dark by default)
===================================== */

/*
    Loaded in the <head> so the right theme is set before the first paint.
    Dark is the default. The little button in the corner switches to the
    original light look and remembers the choice on this device.
*/

(function () {
    "use strict";

    const KEY = "heart-grid-theme";
    const root = document.documentElement;

    function read() {
        try {
            return localStorage.getItem(KEY) === "light" ? "light" : "dark";
        } catch (error) {
            return "dark";
        }
    }

    function apply(theme) {
        root.dataset.theme = theme;

        try {
            localStorage.setItem(KEY, theme);
        } catch (error) {
            // Private mode: the choice just lasts until the page closes.
        }

        const button = document.getElementById("theme-toggle");

        if (button) {
            button.textContent = theme === "dark" ? "LIGHT MODE" : "DARK MODE";
            button.setAttribute("aria-pressed", String(theme === "dark"));
        }
    }

    root.dataset.theme = read();

    document.addEventListener("DOMContentLoaded", () => {
        const button = document.createElement("button");

        button.type = "button";
        button.id = "theme-toggle";
        button.className = "theme-toggle";

        button.addEventListener("click", () => {
            apply(root.dataset.theme === "dark" ? "light" : "dark");
        });

        document.body.appendChild(button);
        apply(root.dataset.theme);
    });
})();
