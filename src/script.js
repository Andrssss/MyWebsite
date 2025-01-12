const toggleThemeButton = document.getElementById("toggleTheme");
const body = document.body;

toggleThemeButton.addEventListener("click", () => {
  // Váltás az éjszakai módra
  body.classList.toggle("dark-mode");

  // Ikon cseréje
  if (body.classList.contains("dark-mode")) {
    toggleThemeButton.textContent = "🌙"; // Holdacska
  } else {
    toggleThemeButton.textContent = "🌞"; // Napocska
  }
});
