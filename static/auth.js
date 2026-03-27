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

    // Check for Email Link Sign-in
    if (auth.isSignInWithEmailLink(window.location.href)) {
        let email = window.localStorage.getItem('emailForSignIn');
        if (!email) {
            email = window.prompt('Please provide your email for confirmation');
        }
        auth.signInWithEmailLink(email, window.location.href)
            .then(() => {
                window.localStorage.removeItem('emailForSignIn');
                window.location.href = "/";
            })
            .catch(err => {
                handleAuthError(err);
            });
    }

    // Toggle Direct Login Form
    const showDirectBtn = document.getElementById("show-direct-login");
    const directForm = document.getElementById("direct-login-form");
    if (showDirectBtn && directForm) {
        showDirectBtn.addEventListener("click", () => {
            directForm.style.display = directForm.style.display === "none" ? "block" : "none";
        });
    }

    // Handle Send Link
    const sendLinkBtn = document.getElementById("send-link-btn");
    const directEmailInput = document.getElementById("direct-email");
    const successMsg = document.getElementById("success-message");

    if (sendLinkBtn) {
        sendLinkBtn.addEventListener("click", () => {
            const email = directEmailInput.value;
            const actionCodeSettings = {
                url: window.location.origin + "/login",
                handleCodeInApp: true
            };

            auth.sendSignInLinkToEmail(email, actionCodeSettings)
                .then(() => {
                    window.localStorage.setItem('emailForSignIn', email);
                    if (successMsg) {
                        successMsg.innerText = "Check your email for the login link!";
                        successMsg.style.display = "block";
                    }
                    if (errorMessage) errorMessage.style.display = "none";
                })
                .catch(err => {
                    handleAuthError(err);
                });
        });
    }

    // Handle Login (Email)
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
                    handleAuthError(err);
                });
        });
    }

    // Handle Google Login
    const googleBtn = document.getElementById("google-login-btn");
    if (googleBtn) {
        googleBtn.addEventListener("click", () => {
            const provider = new firebase.auth.GoogleAuthProvider();
            auth.signInWithPopup(provider)
                .then(() => {
                    window.location.href = "/";
                })
                .catch(err => {
                    handleAuthError(err);
                });
        });
    }

    function handleAuthError(err) {
        if (errorMessage) {
            errorMessage.innerText = err.message;
            errorMessage.style.display = "block";
        }
        if (successMsg) successMsg.style.display = "none";
        console.error("Auth Error:", err);
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
