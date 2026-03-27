// Firebase configuration for NavPath
const firebaseConfig = {
  apiKey: "AIzaSyBWkEfIKRKhmxe-co-n7NWgHgqKpLyEbUo",
  authDomain: "navpath-1bce3.firebaseapp.com",
  projectId: "navpath-1bce3",
  storageBucket: "navpath-1bce3.firebasestorage.app",
  messagingSenderId: "467136701269",
  appId: "1:467136701269:web:f29f38578e23a6347245dc",
  measurementId: "G-3EY0PKZR6E"
};

// Initialize Firebase (using Module SDK script in HTML for simplicity, or provide exports here)
// This file will be loaded before auth.js
if (typeof firebase !== 'undefined') {
    firebase.initializeApp(firebaseConfig);
} else {
    console.error("Firebase SDK not loaded. Make sure to include Firebase scripts in your HTML.");
}
