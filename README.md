# API Documentation

## API Response Structure

### Success Response

- **Code:** 200 (on successful GET/PUT/DELETE)
- **Code:** 201 (on successful POST with DB insertion)
- **Structure:**

```json
{
  "status": "success",
  "message": "success note",
  "data": "response data"
}
```

### Error Response

- **Codes:**
  - 400 → Bad Request
  - 401 → Unauthorized
  - 404 → Not Found
  - 500 → Internal Server Error

- **Structure:**

```json
{
  "status": "error",
  "message": "error note"
}
```

---

## Development Branch Convention

This is the convention we follow for development

- `main` - Productiontion Branch. After final testing completion `dev` branch will be marged to `main` branch.
- `dev` - feature branches will be marged here for final testing.
- `docs` - Document branch. All kind of documents create/update will happen here.
- `feat/<feature-name>` - New feature will be developed in its own branch.

---

## Git Commit Convention

We follow a structured commit message format:

**Structure:**

``` text
<type>(<scope-optional>)/ <description>
```

**Types:**

- feat     → New feature  
- fix      → Bug fix  
- docs     → Documentation changes  
- style    → Code style changes (formatting, missing semi colons, etc)  
- refactor → Code changes that neither fix a bug nor add a feature  
- perf     → Performance improvements  
- test     → Adding or modifying tests  
- revert   → Reverting a previous commit  
- build    → Changes to build system or dependencies  
- ci       → Changes to CI configuration files and scripts  
- chore    → Miscellaneous tasks (maintenance, tooling, etc)  

**Scops:**

- auth     → Authentication, login, logout, JWT, etc  
- user     → User model, User profile, user management  
- docs     → Documentation update
- chart    → Charts related  
- org      → Organization related logic  
- db       → Database schema, migration, queries  
- api      → API endpoints, route handlers  
- ui       → Frontend UI Components  
- form     → Form validation, input handling  
- config   → Project setup, environment, buld config  
- deps     → Dependency update
- email    → Email service, Notification
- payment  → Payment integration, billing
- etl      → Data extraction-transformation-load

**Example:**

``` text
feat(auth)/ login with JWT
```
