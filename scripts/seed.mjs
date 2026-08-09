// Seed the initial SuperAdmin account.
// Run with:  npm run seed
// Reads credentials from .env.local (SEED_SUPERADMIN_*).
import mongoose from "mongoose";
import bcrypt from "bcryptjs";

const {
  MONGODB_URI,
  SEED_SUPERADMIN_NAME,
  SEED_SUPERADMIN_EMAIL,
  SEED_SUPERADMIN_PASSWORD,
} = process.env;

if (!MONGODB_URI) {
  console.error("MONGODB_URI is not set. Add it to .env.local.");
  process.exit(1);
}
if (!SEED_SUPERADMIN_EMAIL || !SEED_SUPERADMIN_PASSWORD) {
  console.error(
    "SEED_SUPERADMIN_EMAIL / SEED_SUPERADMIN_PASSWORD are not set.",
  );
  process.exit(1);
}

const UserSchema = new mongoose.Schema(
  {
    name: String,
    nid: { type: String, default: null },
    address: { type: String, default: null },
    phone: { type: String, default: null },
    email: { type: String, lowercase: true, default: null },
    passwordHash: { type: String, default: null },
    role: { type: String, default: "TENANT" },
    isActive: { type: Boolean, default: true },
    activeBuildingId: { type: mongoose.Schema.Types.ObjectId, default: null },
  },
  { timestamps: true },
);

const AuditLogSchema = new mongoose.Schema(
  {
    action: String,
    entity: String,
    entityId: mongoose.Schema.Types.ObjectId,
    entityLabel: String,
    actorId: mongoose.Schema.Types.ObjectId,
    actorName: String,
    actorRole: String,
    buildingId: mongoose.Schema.Types.ObjectId,
    description: String,
    before: mongoose.Schema.Types.Mixed,
    after: mongoose.Schema.Types.Mixed,
    ip: String,
    userAgent: String,
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

const BuildingSchema = new mongoose.Schema(
  {
    name: String,
    address: String,
    numberOfFloors: Number,
    createdBy: mongoose.Schema.Types.ObjectId,
  },
  { timestamps: true },
);

const UnitSchema = new mongoose.Schema(
  {
    buildingId: mongoose.Schema.Types.ObjectId,
    floorNumber: Number,
    label: String,
    serviceChargeAmount: Number,
  },
  { timestamps: true },
);

const User = mongoose.models.User ?? mongoose.model("User", UserSchema);
const AuditLog =
  mongoose.models.AuditLog ?? mongoose.model("AuditLog", AuditLogSchema);
const Building =
  mongoose.models.Building ?? mongoose.model("Building", BuildingSchema);
const Unit = mongoose.models.Unit ?? mongoose.model("Unit", UnitSchema);

async function ensureSuperAdmin() {
  const email = SEED_SUPERADMIN_EMAIL.toLowerCase();
  const existing = await User.findOne({ email });
  if (existing) {
    console.log(`SuperAdmin already exists: ${email}`);
    return existing;
  }

  const passwordHash = await bcrypt.hash(SEED_SUPERADMIN_PASSWORD, 12);
  const admin = await User.create({
    name: SEED_SUPERADMIN_NAME || "Super Admin",
    email,
    passwordHash,
    role: "SUPER_ADMIN",
    isActive: true,
  });

  await AuditLog.create({
    action: "CREATE",
    entity: "User",
    entityId: admin._id,
    entityLabel: admin.name,
    actorName: "system (seed)",
    actorRole: "SYSTEM",
    description: "Initial SuperAdmin created via seed script.",
    after: { name: admin.name, email: admin.email, role: admin.role },
  });

  console.log(`Created SuperAdmin: ${email}`);
  return admin;
}

async function ensureDemoBuilding(admin) {
  const name = "Matrichaya";
  const existing = await Building.findOne({ name });
  if (existing) {
    console.log(`Demo building already exists: ${name}`);
    return existing;
  }

  const floors = 5;
  const building = await Building.create({
    name,
    address: "House-16, Road-04, Block-B, Banasree, Dhaka-1219",
    numberOfFloors: floors,
    createdBy: admin?._id ?? null,
  });

  // Two units per floor (A/B), labelled like A1, B1, A2, B2 ...
  const units = [];
  for (let floor = 1; floor <= floors; floor++) {
    for (const side of ["A", "B"]) {
      units.push({
        buildingId: building._id,
        floorNumber: floor,
        label: `${side}${floor}`,
        serviceChargeAmount: 3000,
      });
    }
  }
  await Unit.insertMany(units);

  await AuditLog.create({
    action: "CREATE",
    entity: "Building",
    entityId: building._id,
    entityLabel: building.name,
    actorName: "system (seed)",
    actorRole: "SYSTEM",
    buildingId: building._id,
    description: `Demo building created with ${units.length} units.`,
    after: { name: building.name, numberOfFloors: floors, units: units.length },
  });

  console.log(`Created demo building "${name}" with ${units.length} units.`);
  return building;
}

async function main() {
  await mongoose.connect(MONGODB_URI);
  console.log("Connected to MongoDB.");

  const admin = await ensureSuperAdmin();
  await ensureDemoBuilding(admin);

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
