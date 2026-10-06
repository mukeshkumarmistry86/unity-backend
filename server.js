
require('dotenv').config();

const express = require('express');
const mongoose = require('mongoose');
const multer = require('multer');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');

// ─────────────────────────────────────────
// ENV CHECK
// ─────────────────────────────────────────
if (!process.env.MONGO_URI) {
    console.error('❌ MONGO_URI is not set. Create a .env file with MONGO_URI=...');
    process.exit(1);
}

const app = express();
const PORT = process.env.PORT || 3000;

// ─────────────────────────────────────────
// SECURITY
// ─────────────────────────────────────────
app.use(helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    contentSecurityPolicy: false
}));

// ─────────────────────────────────────────
// CORS — simple, allows all origins
// (No credentials — Unity WebGL doesn't need them)
// ─────────────────────────────────────────
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

// Handle preflight for all routes
app.options('*', cors());

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ─────────────────────────────────────────
// RATE LIMIT
// ─────────────────────────────────────────
app.use('/api/', rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 200,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again later.' }
}));

// ─────────────────────────────────────────
// MONGODB
// ─────────────────────────────────────────
let gridfsBucket;

mongoose.connect(process.env.MONGO_URI)
    .then(() => {
        console.log('✅ MongoDB connected');
        gridfsBucket = new mongoose.mongo.GridFSBucket(mongoose.connection.db, {
            bucketName: 'uploads'
        });
    })
    .catch(err => {
        console.error('❌ MongoDB connection failed:', err.message);
        process.exit(1);
    });

// ─────────────────────────────────────────
// MULTER (memory storage → GridFS)
// ─────────────────────────────────────────
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const ok = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
        if (!ok.includes(file.mimetype)) {
            return cb(new Error('Only image files allowed'));
        }
        cb(null, true);
    }
});

function saveToGridFS(buffer, filename, mimetype) {
    return new Promise((resolve, reject) => {
        const stream = gridfsBucket.openUploadStream(filename, {
            contentType: mimetype
        });
        stream.on('error', reject);
        stream.on('finish', () => resolve(stream.id));
        stream.end(buffer);
    });
}

// ─────────────────────────────────────────
// USER MODEL
// ─────────────────────────────────────────
const userSchema = new mongoose.Schema({
    name: { type: String, required: true, trim: true, maxlength: 100 },
    mobileNo: { type: String, required: true, trim: true, maxlength: 20 },
    email: { type: String, required: true, trim: true, lowercase: true, maxlength: 200 },
    profileImageId: { type: mongoose.Schema.Types.ObjectId, default: null },
    profileImageUrl: { type: String, default: null }
}, { timestamps: true });

const User = mongoose.model('User', userSchema);

// ─────────────────────────────────────────
// STATIC ADMIN PANEL
// ─────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'admin')));

// ─────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────

app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        db: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
        timestamp: new Date().toISOString()
    });
});

// CREATE user
app.post('/api/users', upload.single('profileImage'), async (req, res) => {
    try {
        const { name, mobileNo, email } = req.body;

        if (!name || !mobileNo || !email) {
            return res.status(400).json({ error: 'Name, MobileNo, and Email are required' });
        }
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            return res.status(400).json({ error: 'Invalid email format' });
        }

        const userData = {
            name: name.trim(),
            mobileNo: mobileNo.trim(),
            email: email.trim().toLowerCase()
        };

        if (req.file) {
            const ext = path.extname(req.file.originalname) || '.jpg';
            const filename = `profile_${Date.now()}${ext}`;
            const fileId = await saveToGridFS(req.file.buffer, filename, req.file.mimetype);
            userData.profileImageId = fileId;
            userData.profileImageUrl = `/api/images/${fileId}`;
        }

        const user = new User(userData);
        await user.save();

        res.status(201).json({
            message: 'User created successfully',
            user: {
                id: user._id,
                name: user.name,
                mobileNo: user.mobileNo,
                email: user.email,
                profileImageUrl: user.profileImageUrl,
                createdAt: user.createdAt
            }
        });
    } catch (err) {
        console.error('POST /api/users:', err);
        res.status(500).json({ error: err.message || 'Server error' });
    }
});

// READ all users
app.get('/api/users', async (req, res) => {
    try {
        const users = await User.find().sort({ createdAt: -1 }).lean();
        res.json(users.map(u => ({
            _id: u._id,
            name: u.name,
            mobileNo: u.mobileNo,
            email: u.email,
            profileImageId: u.profileImageId,
            profileImageUrl: u.profileImageId ? `/api/images/${u.profileImageId}` : null,
            createdAt: u.createdAt
        })));
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

// READ one user
app.get('/api/users/:id', async (req, res) => {
    try {
        const user = await User.findById(req.params.id).lean();
        if (!user) return res.status(404).json({ error: 'User not found' });
        res.json(user);
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

// DELETE user
app.delete('/api/users/:id', async (req, res) => {
    try {
        const user = await User.findByIdAndDelete(req.params.id);
        if (!user) return res.status(404).json({ error: 'User not found' });

        if (user.profileImageId) {
            try { await gridfsBucket.delete(user.profileImageId); } catch (_) {}
        }
        res.json({ message: 'User deleted' });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

// SERVE image from GridFS
app.get('/api/images/:id', async (req, res) => {
    try {
        const fileId = new mongoose.Types.ObjectId(req.params.id);
        const files = await mongoose.connection.db
            .collection('uploads.files')
            .find({ _id: fileId })
            .toArray();

        if (!files || files.length === 0) {
            return res.status(404).json({ error: 'Image not found' });
        }

        res.set('Content-Type', files[0].contentType || 'image/jpeg');
        res.set('Cache-Control', 'public, max-age=31536000');

        const stream = gridfsBucket.openDownloadStream(fileId);
        stream.on('error', () => res.status(500).end());
        stream.pipe(res);
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

// ─────────────────────────────────────────
// ERROR HANDLER
// ─────────────────────────────────────────
app.use((err, req, res, next) => {
    console.error('Error:', err.message);
    if (err.message === 'Not allowed by CORS') {
        return res.status(403).json({ error: 'CORS: origin not allowed' });
    }
    if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'File too large (max 5 MB)' });
    }
    res.status(500).json({ error: err.message || 'Internal server error' });
});

// ─────────────────────────────────────────
// START
// ─────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    console.log(`   Admin panel: http://localhost:${PORT}/admin.html`);
});