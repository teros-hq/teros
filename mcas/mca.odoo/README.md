# Odoo MCA

Integration with [Odoo ERP](https://www.odoo.com) via the Odoo JSON-RPC API. This MCA lets agents query and modify almost any Odoo record using API-key authentication.

## Authentication

This MCA uses **API key authentication** (no OAuth). You must provide three user secrets when installing the app:

- `BASE_URL` — Your Odoo instance URL, e.g. `https://mycompany.odoo.com`
- `DATABASE` — Your Odoo database name, e.g. `mycompany`
- `API_KEY` — An Odoo user API key

### How to create an Odoo API key

1. Log in to Odoo as the user that will perform the integration actions.
2. Open your user profile (top-right avatar → **Preferences / My Profile**).
3. Go to the **Account Security** tab.
4. Click **New API key** and give it a name (e.g. "Teros").
5. Copy the generated key and paste it into the MCA settings.

> Make sure the Odoo user has the required permissions (groups/ACLs) for the models you want to access.

## How Odoo JSON-RPC works

Odoo exposes a `/jsonrpc` endpoint. This MCA calls the `execute_kw` service on the `object` endpoint to run model methods such as `search_read`, `read`, `create`, `write`, `unlink`, `search_count`, and any custom public method.

## Tools

### Generic model operations

| Tool | Description |
|------|-------------|
| `list-models` | List available Odoo models (`ir.model`). |
| `search-records` | Search and read records from any model. |
| `get-record` | Read a single record by ID. |
| `create-record` | Create a record in any model. |
| `update-record` | Update a record by ID. |
| `delete-record` | Delete a record by ID. |
| `count-records` | Count records matching filters. |
| `call-method` | Call any public model method. |

### CRM & Sales

| Tool | Description |
|------|-------------|
| `list-partners` | List contacts / companies (`res.partner`). |
| `get-partner` | Get a partner by ID. |
| `create-partner` | Create a new contact or company. |
| `update-partner` | Update a partner. |
| `list-products` | List products (`product.template`). |
| `list-sale-orders` | List sales orders (`sale.order`). |
| `get-sale-order` | Get a sales order by ID. |
| `create-sale-order` | Create a sales order with optional lines. |
| `list-invoices` | List customer invoices (`account.move`). |

### Projects

| Tool | Description |
|------|-------------|
| `list-projects` | List projects (`project.project`). |
| `list-tasks` | List project tasks (`project.task`). |
| `create-project-task` | Create a new project task. |

### HR

| Tool | Description |
|------|-------------|
| `list-employees` | List employees (`hr.employee`). |
| `list-leaves` | List time-off requests (`hr.leave`). |
| `create-leave` | Create a time-off request. |
| `list-timesheets` | List timesheet entries (`account.analytic.line`). |
| `create-timesheet` | Create a timesheet entry. |

## Filter syntax

Several tools accept a `filters` string with comma-separated comparisons:

```
is_company=true
name=Acme
amount_total>1000
state=sale
```

Supported operators: `=`, `!=`, `>`, `<`, `>=`, `<=`.

## Example usage

```text
List the first 10 companies in Odoo.
→ list-partners with filters="is_company=true" and limit=10

Create a sales order for partner 42 with one product line.
→ create-sale-order partnerId=42 orderLines=[{productId: 7, quantity: 2, priceUnit: 50}]

List open tasks for project 5.
→ list-tasks projectId=5
```

## Limitations

- Odoo model and field names must be provided in their technical form (e.g. `res.partner`, `sale.order`).
- Many2one / Many2many values are returned as `[id, display_name]` tuples.
- Creating records with complex relations may require using `create-record` with raw Odoo values (e.g. `[(6, 0, [ids])]` for Many2many).
- The MCA does not handle OAuth2 or session cookies; it relies on the API key method.
- Odoo Online (odoo.com) may require an Enterprise or custom plan to enable API access depending on the model.

## Official docs

- https://www.odoo.com/documentation/master/developer/reference/external_api.html
