require('dotenv').config();
const express = require('express');
const mysql = require('mysql2');
const session = require('express-session');
const MySQLStore = require('express-mysql-session')(session);
const bcrypt = require('bcrypt');
const { body, validationResult } = require('express-validator');
const path = require('path');

const app = express();
const saltRounds = 10;

// Middleware
app.set('trust proxy', 1); // Required behind hosting proxies (Railway, Render) so secure cookies work
app.use(express.json());
app.use(express.static(__dirname)); // Serve static files

// MySQL Configuration
const dbConfig = {
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'financial_planner',
};

// Database Connection
const db = mysql.createConnection(dbConfig);
db.connect((err) => {
    if (err) {
        console.error('Error connecting to MySQL:', err);
        process.exit(1);
    }
});

// MySQL Session Store
const sessionStore = new MySQLStore({}, db);

// Session Configuration
app.use(session({
    key: 'user_session',
    secret: process.env.SESSION_SECRET,
    store: sessionStore,
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production', // HTTPS-only cookies in production, plain HTTP locally
        maxAge: 1000 * 60 * 60 * 24, // 1 day
    },
}));

// Reconnect logic for database disconnections
db.on('error', (err) => {
    if (err.code === 'PROTOCOL_CONNECTION_LOST') {
        reconnect();
    } else {
        throw err;
    }
});

function reconnect() {
    db.connect((err) => {
        if (err) {
            console.error('Error reconnecting to MySQL:', err); // Log the error
            setTimeout(reconnect, 5000); // Retry connection after 5 seconds
        } else {
            console.log('Reconnected to MySQL!');
        }
    });
}

// Middleware to Protect Routes
function authenticate(req, res, next) {
    if (req.session.userId) {
        next();
    } else {
        res.status(401).json({ error: 'Unauthorized. Please log in.' });
    }
}

// Routes

// Serve the Home Page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Verify Session Route
app.get('/session', authenticate, (req, res) => {
    res.status(200).json({
        userId: req.session.userId,
        email: req.session.email,
    });
});

// Register User
app.post(
    '/register',
    [
        body('email').isEmail().withMessage('Invalid email format'),
        body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters long'),
    ],
    async (req, res) => {
	console.log('Received POST /register');
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ errors: errors.array() });
        }

        const { email, password } = req.body;

        try {
            const hashedPassword = await bcrypt.hash(password, saltRounds);
            const query = 'INSERT INTO users (email, password) VALUES (?, ?)';
            db.query(query, [email, hashedPassword], (err) => {
                if (err) {
                    console.error(err);
                    return res.status(500).json({ error: 'User already exists or invalid data' });
                }
                res.status(201).json({ message: 'User registered successfully' });
            });
        } catch (error) {
            console.error(error);
            res.status(500).json({ error: 'Failed to register user' });
        }
    }
);

// Login User
app.post('/login', (req, res) => {
    const { email, password } = req.body;
    
    const query = 'SELECT * FROM users WHERE email = ?';
    db.query(query, [email], async (err, results) => {
        if (err) {
        	console.error('Database error:', err);
            return res.status(500).json({ error: 'Invalid email or password' });
        }
        
        if (results.length === 0) {
        	console.log('No user found with that email.');
        	return res.status(401).json({ error: 'Database error'});
        }

        const user = results[0];

        try {
            const isPasswordValid = await bcrypt.compare(password, user.password);

            if (!isPasswordValid) {
                return res.status(401).json({ error: 'Invalid email or password' });
            }

            // Store user ID in session
            req.session.userId = user.id;
            req.session.email = user.email;

            res.status(200).json({ message: 'Login successful' });
        } catch (error) {
            console.error('Error during password validation', error);
            res.status(500).json({ error: 'Password comparison failed' });
        }
    });
});

// Logout Route
app.post('/logout', (req, res) => {
    req.session.destroy(err => {
        if (err) {
            console.error('Error destroying session:', err);
            return res.status(500).json({ error: 'Failed to log out' });
        }
        res.clearCookie('user_session'); // Clear session cookie
        res.status(200).json({ message: 'Logged out successfully' });
    });
});

app.post('/profile', authenticate, async (req, res) => {
    const { email, password } = req.body;
    const userId = req.session.userId;

    if (!email || !password) {
        return res.status(400).json({ error: 'All fields are required.' });
    }

    try {
        const hashedPassword = await bcrypt.hash(password, saltRounds);
        const query = 'UPDATE users SET email = ?, password = ? WHERE id = ?';
        db.query(query, [email, hashedPassword, userId], (err) => {
            if (err) {
                console.error('Error updating profile:', err);
                return res.status(500).json({ error: 'Failed to update profile.' });
            }
            req.session.email = email; // Update session email
            res.status(200).json({ message: 'Profile updated successfully.' });
        });
    } catch (error) {
        console.error('Error hashing password:', error);
        res.status(500).json({ error: 'An error occurred. Please try again.' });
    }
});

// Add Budget
app.post('/budgets', authenticate, (req, res) => {
    const { category, amount } = req.body;
    const userId = req.session.userId;
    
    if (!category || !amount) {
        return res.status(400).json({ error: 'All fields are required' });
    }

    const query = 'INSERT INTO budgets (user_id, category, amount) VALUES (?, ?, ?)';
    db.query(query, [userId, category, amount], (err, result) => {
        if (err) {
            console.error(err);
            return res.status(500).json({ error: 'Failed to add budget' });
        }
        
        // Respond with the newly created budget, including all fields
        const newBudget = {
        	id: result.insertId,
        	user_id: userId,
        	category,
        	amount,
        };
        
        res.status(201).json(newBudget)
    });
});

// Get Budgets
app.get('/budgets', authenticate, (req, res) => {
    const userId = req.session.userId;
    
    if (!userId) {
    	console.error('User ID not found in session');
    	return res.status(401).json({ error: 'Unauthorized'});
    	}

    const query = 'SELECT * FROM budgets WHERE user_id = ?';
    db.query(query, [userId], (err, results) => {
        if (err) {
            console.error(err);
            return res.status(500).json({ error: 'Failed to fetch budgets' });
        }
        res.status(200).json(results);
    });
});
// Delete Budgets
app.delete('/budgets/:budgetId', authenticate, (req, res) => {
    const { budgetId } = req.params;

    if (!budgetId) {
        return res.status(400).json({ error: 'Budget ID is required' });
    }

    const deleteTransactionsQuery = 'DELETE FROM transactions WHERE budget_id = ?';
   	const deleteBudgetQuery = 'DElETE FROM budgets WHERE id = ?';
   	
   	db.query(deleteTransactionsQuery, [budgetId], (err) => {
   		if (err) {
   			console.error('Error deleting transactions:', err);
   			return res.status(500).json({ error: 'Failed to delete transactions'});
   		}
   		
   		db.query(deleteBudgetQuery, [budgetId], (err, result) => {
   			if (err) {
   				console.error('Error deleting budget:', err);
   				return res.status(500).json({ error: 'Failed to delete budget'});
   			}
   			
   			if (result.affectedRows === 0) {
   				console.error('No budget found with the given ID');
   				return res.status(404).json({ error: 'Budget not found' });
   			}
   			
   			res.status(200).json({ message: 'Budget and associated transactions deleted successfully' });
   		});
   	});
});

// Add Transaction
app.post('/transactions', authenticate, (req, res) => {
    const { budgetId, title, amount } = req.body;

    if (!budgetId || !title || !amount) {
        return res.status(400).json({ error: 'All fields are required' });
    }

	const parsedAmount = parseFloat(amount);
	if (isNaN(parsedAmount)) {
		return res.status(400).json({ error: 'Invalid amount' });
	}

    const query = 'INSERT INTO transactions (budget_id, title, amount) VALUES (?, ?, ?)';
    db.query(query, [budgetId, title, parsedAmount], (err, result) => {
        if (err) {
            console.error('Error adding transaction:', err);
            return res.status(500).json({ error: 'Failed to add transaction' });
        }

        const newTransaction = {
            id: result.insertId,
            budget_id: budgetId,
            title,
            amount: parsedAmount,
        };

        res.status(201).json(newTransaction);
    });
});

app.get('/transactions/:budgetId', authenticate, (req, res) => {
    const { budgetId } = req.params;


    if (!budgetId) {
        return res.status(400).json({ error: 'Budget ID is required' });
    }

    const query = 'SELECT * FROM transactions WHERE budget_id = ?';
    db.query(query, [budgetId], (err, results) => {
        if (err) {
            console.error('Error fetching transactions:', err);
            return res.status(500).json({ error: 'Failed to fetch transactions' });
        }
        res.status(200).json(results);
    });
});

// Get All Transactions for the User
app.get('/transactions', authenticate, (req, res) => {
	const userId = req.session.userId;
	
	const query = `
		SELECT t.id, t.budget_id, t.title, t.amount
		FROM transactions t
		JOIN budgets b ON t.budget_id = b.id
		WhERE b.user_id = ?
	`;
	db.query(query, [userId], (err, results) => {
		if (err) {
			console.error('Error fetching transactions for user:', err);
			return res.status(500).json({ error: 'Failed to fetch transactions' });
		}
		res.status(200).json(results);
	});
});	

// Delete a Transaction
app.delete('/transactions/:transactionId', authenticate, (req, res) => {
    const { transactionId } = req.params;
    
    if (!transactionId) {
        return res.status(400).json({ error: 'Transaction ID is required' });
    }

    const query = 'DELETE FROM transactions WHERE id = ?';
    db.query(query, [transactionId], (err, result) => {
        if (err) {
            console.error('Error deleting transaction:', err);
            return res.status(500).json({ error: 'Failed to delete transaction' });
        }

        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Transaction not found' });
        }

        res.status(200).json({ message: 'Transaction deleted successfully' });
    });
});

app.get('/monthly-income', authenticate, (req, res) => {
    const userId = req.session.userId;

    const query = 'SELECT monthly_income FROM users WHERE id = ?';
    db.query(query, [userId], (err, results) => {
        if (err) {
            console.error('Error fetching monthly income:', err);
            return res.status(500).json({ error: 'Failed to fetch monthly income' });
        }

        if (results.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }

        res.status(200).json({ monthlyIncome: results[0].monthly_income });
    });
});

app.put('/monthly-income', authenticate, (req, res) => {
    const userId = req.session.userId;
    const { monthlyIncome } = req.body;

    if (!monthlyIncome || monthlyIncome <= 0) {
        return res.status(400).json({ error: 'Invalid monthly income' });
    }

    const query = 'UPDATE users SET monthly_income = ? WHERE id = ?';
    db.query(query, [monthlyIncome, userId], (err, results) => {
        if (err) {
            console.error('Error updating monthly income:', err);
            return res.status(500).json({ error: 'Failed to update monthly income' });
        }

        res.status(200).json({ message: 'Monthly income updated successfully' });
    });
});

// Guest demo: create a throwaway, pre-seeded user and log in as them.
// Each visitor gets their own data (no clobbering), and old guest accounts are pruned
// so the table can't grow without bound. Guest accounts use the @demo.local domain.
app.post('/guest', async (req, res) => {
    const p = db.promise();
    try {
        // Keep only the 25 most recent guest accounts; older ones (and their budgets
        // and transactions, via ON DELETE CASCADE) are removed.
        await p.query(
            `DELETE FROM users
             WHERE email LIKE '%@demo.local'
               AND id NOT IN (
                 SELECT id FROM (
                   SELECT id FROM users
                   WHERE email LIKE '%@demo.local'
                   ORDER BY id DESC
                   LIMIT 25
                 ) AS recent
               )`
        );

        // Create a fresh guest user (random password; the visitor is logged in directly).
        const email = `guest_${Date.now()}_${Math.random().toString(36).slice(2, 8)}@demo.local`;
        const hashed = await bcrypt.hash(Math.random().toString(36), saltRounds);
        const [user] = await p.query(
            'INSERT INTO users (email, password, monthly_income) VALUES (?, ?, ?)',
            [email, hashed, 4000]
        );
        const userId = user.insertId;

        // Seed a few budgets, each with a sample transaction, so the demo isn't empty.
        const seed = [['Groceries', 500], ['Rent', 1200], ['Entertainment', 150]];
        for (const [category, amount] of seed) {
            const [budget] = await p.query(
                'INSERT INTO budgets (user_id, category, amount) VALUES (?, ?, ?)',
                [userId, category, amount]
            );
            await p.query(
                'INSERT INTO transactions (budget_id, title, amount) VALUES (?, ?, ?)',
                [budget.insertId, `Sample ${category.toLowerCase()} expense`, Math.round(amount * 0.3 * 100) / 100]
            );
        }

        // Log the visitor in as this guest.
        req.session.userId = userId;
        req.session.email = email;
        res.status(200).json({ message: 'Guest session started' });
    } catch (err) {
        console.error('Error starting guest session:', err);
        res.status(500).json({ error: 'Failed to start guest session' });
    }
});

// Start Server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});