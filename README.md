# Real-Time Poker Game Backend

This is the backend for a real-time, multi-player Texas Hold'em poker game built with Node.js, Express, Socket.IO, and MongoDB. It features a complete game engine with support for side pots and stable handling of player disconnections.



***
## Features

-   ✅ **Secure User Authentication:** Full user registration and login with JWT (JSON Web Tokens).
-   ⚡ **Real-Time Gameplay:** Live game action, betting, and updates using WebSockets (Socket.IO).
-   🃏 **Complete Poker Logic:** A full Texas Hold'em engine that handles blinds, betting rounds, and complex side pot calculations for multi-way all-in scenarios.
-   🚪 **In-Memory Room Management:** Players can create, join, and leave game rooms.
-   🛡️ **Stable Disconnection Handling:** Players who disconnect mid-hand are automatically folded without crashing the game.

***
## Technologies Used

-   **Backend:** Node.js, Express.js
-   **Real-Time Communication:** Socket.IO
-   **Database:** MongoDB with Mongoose
-   **Authentication:** JWT, bcrypt
-   **Poker Hand Evaluation:** pokersolver

***
## Setup and Installation

To run this project locally, follow these steps:

1.  **Clone the repository:**
    ```bash
    git clone [https://github.com/PrimeSumit/Poker-Multiplayer-Backend.git](https://github.com/PrimeSumit/Poker-Multiplayer-Backend.git)
    ```
2.  **Navigate to the project directory:**
    ```bash
    cd Poker-Multiplayer-Backend
    ```
3.  **Install dependencies:**
    ```bash
    npm install
    ```
4.  **Create a `.env` file** in the root directory and add the following variables. Get your MongoDB URI from MongoDB Atlas.
    ```
    PORT=5000
    MONGO_URI=your_mongodb_connection_string
    JWT_SECRET=your_super_secret_jwt_key
    ```
5.  **Start the server:**
    ```bash
    npm start
    ```
The server will be running at `http://localhost:5000`.

***
## API Endpoints

-   `POST /api/auth/register`: Register a new user.
-   `POST /api/auth/login`: Log in a user and receive a JWT.
-   `GET /api/auth/me`: Get the logged-in user's profile (requires JWT).
