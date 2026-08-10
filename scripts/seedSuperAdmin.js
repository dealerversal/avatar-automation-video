import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { connectDB } from '../src/db.js';

async function seedSuperAdmin() {
    const username = 'superadmin';
    const email = 'superadmin@dealerversal.com';
    const password = 'superadmin@9661';

    console.log(`Connecting to MongoDB...`);
    const db = await connectDB();
    const superAdmins = db.collection('super_admins');

    const passwordHash = await bcrypt.hash(password, 12);
    const existing = await superAdmins.findOne({ email });

    if (existing) {
        await superAdmins.updateOne({ email }, { $set: { passwordHash, updatedAt: new Date() } });
        console.log(`✅ Updated Super Admin credentials for "${email}"!`);
    } else {
        const newAdmin = {
            username,
            email,
            name: 'Super Admin',
            passwordHash,
            role: 'super_admin',
            createdAt: new Date(),
            updatedAt: new Date(),
        };
        await superAdmins.insertOne(newAdmin);
        console.log(`✅ Super Admin created successfully in avatar-automation-video!`);
    }

    console.log(`   Email:    ${email}`);
    console.log(`   Password: ${password}`);

    process.exit(0);
}

seedSuperAdmin().catch((err) => {
    console.error('❌ Failed to seed Super Admin:', err);
    process.exit(1);
});
