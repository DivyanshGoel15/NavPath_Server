// NavPath Authentication Logic
document.addEventListener("DOMContentLoaded", function() {
    const loginForm = document.getElementById("login-form");
    const logoutBtn = document.getElementById("logout-btn");
    const errorMessage = document.getElementById("error-message");

    // Initialize Firebase Auth
    const auth = firebase.auth();

    // Monitor Auth State
    auth.onAuthStateChanged(user => {
        const path = window.location.pathname;
        if (user) {
            console.log("User logged in:", user.email);
            // If on login page, redirect to dashboard
            if (path === "/login") {
                window.location.href = "/";
            }
        } else {
            console.log("No user logged in.");
            // If on dashboard or ambulance app, redirect to login
            if (path === "/" || path === "/hospital" || path === "/ambulance") {
                window.location.href = "/login";
            }
        }
    });

    // Handle Login
    if (loginForm) {
        loginForm.addEventListener("submit", (e) => {
            e.preventDefault();
            const email = loginForm["email"].value;
            const password = loginForm["password"].value;

            auth.signInWithEmailAndPassword(email, password)
                .then(() => {
                    window.location.href = "/";
                })
                .catch(err => {
                    if (errorMessage) {
                        errorMessage.innerText = err.message;
                        errorMessage.style.display = "block";
                    }
                    console.error("Login Error:", err);
                });
        });
    }

    // Handle Logout
    if (logoutBtn) {
        logoutBtn.addEventListener("click", () => {
            auth.signOut().then(() => {
                window.location.href = "/login";
            });
        });
    }
});
