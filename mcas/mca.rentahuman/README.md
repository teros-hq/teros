# RentAHuman.ai MCA

Hire humans for physical-world tasks directly from your Teros agents.

## What is RentAHuman.ai?

[RentAHuman.ai](https://rentahuman.ai) is a marketplace where AI agents can hire humans for tasks that require physical presence: errands, in-person meetings, field research, photography, deliveries, hardware setup, and more. 657,000+ verified humans in 50+ countries.

## Tools

| Tool | Auth Required | Description |
|------|--------------|-------------|
| `search-humans` | ❌ Free | Search humans by skill, rate, or name |
| `get-human` | ❌ Free | Get full profile with availability & wallets |
| `create-booking` | ✅ API Key | Book a human for a task |
| `list-bookings` | ✅ API Key | List your agent's bookings |
| `get-booking` | ✅ API Key | Get status of a specific booking |

## Setup

### 1. Get an API Key (optional — only needed for bookings)

- Sign up at [rentahuman.ai](https://rentahuman.ai)
- Go to your dashboard → API Keys
- Create a key (starts with `rah_`)

### 2. Configure the MCA

Add your API key in the MCA app settings:
- Secret name: `RENTAHUMAN_API_KEY`
- Value: `rah_your_key_here`

> **Note:** Searching and browsing humans is completely free and requires no API key.

## Example Usage

```
# Search for photographers in New York
search-humans(skill="Photography", maxRate=50)

# Get a specific human's full profile
get-human(humanId="abc123")

# Book a human for an errand
create-booking(
  humanId="abc123",
  taskTitle="Pick up package from FedEx",
  taskDescription="Pick up a package (tracking: 1Z999...) from the FedEx at 123 Main St and bring it to 456 Oak Ave. Package is ~2kg.",
  taskCategory="errands",
  startTime="2025-06-15T10:00:00Z",
  estimatedHours=2
)

# Check your bookings
list-bookings(status="pending")

# Get booking status
get-booking(bookingId="booking_xyz")
```

## Pricing

- **Searching:** Free
- **Agent account:** Free
- **Bookings:** Platform fee included in escrow (transparent)
- **Operator account** (for messaging): $9.99/month

## Links

- [Docs](https://rentahuman.ai/docs)
- [API Reference](https://rentahuman.ai/api-docs)
- [MCP Integration](https://rentahuman.ai/mcp)
