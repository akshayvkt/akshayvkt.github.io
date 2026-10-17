document.addEventListener("DOMContentLoaded", () => {
    const toggleBtn = document.getElementById("toggleBtn");

    toggleBtn.addEventListener("click", () => {
        document.body.classList.toggle("dark-mode");
        const moonIcon = '<i class="fas fa-moon white-moon"></i>';
        const sunIcon = '<i class="fas fa-sun yellow-sun"></i>';

        if (document.body.classList.contains("dark-mode")) {
            toggleBtn.innerHTML = sunIcon;
        } else {
            toggleBtn.innerHTML = moonIcon;
        }
    });
});