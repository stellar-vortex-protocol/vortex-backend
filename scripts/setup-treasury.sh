#!/bin/bash
# Treasury Accounting Service Setup Script
# 
# This script sets up the treasury accounting service after the code is merged.

set -e

echo "🏦 Setting up Treasury Accounting Service..."
echo ""

# Check if npm is available
if ! command -v npm &> /dev/null; then
    echo "❌ npm not found. Please install Node.js and npm first."
    exit 1
fi

# Install @nestjs/schedule if not already installed
echo "📦 Checking dependencies..."
if ! npm list @nestjs/schedule &> /dev/null; then
    echo "Installing @nestjs/schedule..."
    npm install @nestjs/schedule
else
    echo "✓ @nestjs/schedule already installed"
fi

# Generate Prisma client
echo ""
echo "🔧 Generating Prisma client..."
npm run db:generate

# Run database migration
echo ""
echo "📊 Running database migration..."
read -p "Do you want to run the migration now? (y/N) " -n 1 -r
echo ""
if [[ $REPLY =~ ^[Yy]$ ]]; then
    npm run db:migrate
    echo "✓ Migration completed"
else
    echo "⚠️  Skipped migration. Run 'npm run db:migrate' manually when ready."
fi

# Check environment variables
echo ""
echo "🔍 Checking environment configuration..."
ENV_FILE=".env"
MISSING_VARS=()

if [ ! -f "$ENV_FILE" ]; then
    echo "⚠️  No .env file found. Copy .env.example to .env and configure:"
    echo "   cp .env.example .env"
    ENV_FILE=".env.example"
fi

if ! grep -q "^HORIZON_URL=" "$ENV_FILE"; then
    MISSING_VARS+=("HORIZON_URL")
fi

if ! grep -q "^TREASURY_ADDRESS=" "$ENV_FILE"; then
    MISSING_VARS+=("TREASURY_ADDRESS")
fi

if [ ${#MISSING_VARS[@]} -gt 0 ]; then
    echo "⚠️  Missing environment variables:"
    for var in "${MISSING_VARS[@]}"; do
        echo "   - $var"
    done
    echo ""
    echo "   Add these to your .env file before running the service."
else
    echo "✓ All required environment variables are configured"
fi

# Run tests
echo ""
read -p "Do you want to run the treasury service tests? (y/N) " -n 1 -r
echo ""
if [[ $REPLY =~ ^[Yy]$ ]]; then
    echo "🧪 Running tests..."
    npm test -- treasury.service.spec.ts
    echo "✓ Tests completed"
else
    echo "⚠️  Skipped tests. Run 'npm test -- treasury.service.spec.ts' manually."
fi

echo ""
echo "✅ Treasury Accounting Service setup complete!"
echo ""
echo "📖 Next steps:"
echo "   1. Configure HORIZON_URL and TREASURY_ADDRESS in .env"
echo "   2. Start the server: npm run dev"
echo "   3. Test the API: GET http://localhost:4000/api/v1/treasury/reconciliation"
echo "   4. Trigger manual reconciliation: POST http://localhost:4000/api/v1/treasury/reconciliation/trigger"
echo ""
echo "📚 Documentation:"
echo "   - Module README: src/treasury/README.md"
echo "   - Implementation summary: TREASURY_IMPLEMENTATION_SUMMARY.md"
echo "   - Integration examples: src/treasury/treasury.integration.example.ts"
echo ""
