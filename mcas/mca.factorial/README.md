# Factorial MCA

Integration with [Factorial HR](https://factorialhr.com) via their public REST API.

## Authentication

OAuth 2.0 — users connect their Factorial account. The MCA requests scopes for:
- `employees` — read employee data and teams
- `time_off` — manage vacation/sick leave requests
- `time_tracking` — read attendance, shifts, worked times
- `documents` — read company documents
- `contracts` — read contract versions and compensations
- `company_locations` — read office locations
- `company_legal_entities` — read legal entities

## Tools

### Employees
- `list-employees` — list all employees with filters
- `get-employee` — get a specific employee by ID

### Teams
- `list-teams` — list all teams
- `list-team-memberships` — list employee-team associations

### Time Off
- `list-leaves` — list time-off requests
- `get-leave` — get a specific leave request
- `create-leave` — create a new time-off request
- `list-leave-types` — list available leave types

### Attendance
- `list-shifts` — list attendance shifts
- `list-worked-times` — list worked time records
- `list-overtime-requests` — list overtime requests
- `approve-overtime` — approve an overtime request
- `reject-overtime` — reject an overtime request

### Documents
- `list-documents` — list company documents
- `get-document` — get a specific document

### Contracts & Payroll
- `list-contract-versions` — list employee contract versions
- `list-compensations` — list compensation records

### Company
- `list-legal-entities` — list legal entities
- `list-locations` — list work locations

## Sandbox

Factorial provides a demo environment at `https://demo.factorialhr.com` with API at `https://api.demo.factorial.dev`.

## Official Docs

https://apidoc.factorialhr.com
