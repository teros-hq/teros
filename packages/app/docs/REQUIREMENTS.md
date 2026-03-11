# app - Requirements

**Package**: `@teros/app`  
**Purpose**: Mobile/web chat interface for conversing with AI agents

---

## 1. Functional Requirements

### 1.1 Authentication
- **FR-1.1.1**: Login with email/password
- **FR-1.1.2**: Session persistence (survive app restart)
- **FR-1.1.3**: Logout functionality
- **FR-1.1.4**: Auto-redirect to login if session expired

### 1.2 Conversation Management
- **FR-1.2.1**: Display list of conversations (active/archived)
- **FR-1.2.2**: Create new conversation with agent selection
- **FR-1.2.3**: Archive/unarchive conversations
- **FR-1.2.4**: Delete conversations (with confirmation)
- **FR-1.2.5**: Search conversations by title or content

### 1.3 Messaging
- **FR-1.3.1**: Send text messages to agent
- **FR-1.3.2**: Receive messages in real-time (WebSocket)
- **FR-1.3.3**: Display message status (sending, sent ✓, delivered ✓✓)
- **FR-1.3.4**: Show typing indicators when agent is responding
- **FR-1.3.5**: Render markdown in messages
- **FR-1.3.6**: Display timestamps

### 1.4 Agent Selection
- **FR-1.4.1**: List available AI agents (Alice, Berta, Iria, etc.)
- **FR-1.4.2**: Show agent avatar, name, and description
- **FR-1.4.3**: Filter agents by capability/role

---

## 2. Technical Requirements

### 2.1 Framework
- **TR-2.1.1**: React Native (Expo SDK 54+)
- **TR-2.1.2**: Expo Router for navigation
- **TR-2.1.3**: TypeScript with strict mode

### 2.2 Dependencies
- **TR-2.2.1**: `tamagui` - UI components
- **TR-2.2.2**: `zustand` - State management
- **TR-2.2.3**: `react-native-markdown-display` - Markdown rendering
- **TR-2.2.4**: `@teros/shared` - Protocol types
- **TR-2.2.5**: `date-fns` - Date formatting

### 2.3 Architecture
- **TR-2.3.1**: File-based routing (`app/` directory)
- **TR-2.3.2**: WebSocket client in `src/services/TerosClient.ts`
- **TR-2.3.3**: Zustand stores for state
- **TR-2.3.4**: Component-based UI

### 2.4 Integration
- **TR-2.4.1**: WebSocket connection to backend
- **TR-2.4.2**: Auto-reconnect on disconnect
- **TR-2.4.3**: Queue messages when offline

---

## 3. Operational Requirements

### 3.1 Platforms
- **OR-3.1.1**: Web (primary target)
- **OR-3.1.2**: iOS (future)
- **OR-3.1.3**: Android (future)

### 3.2 Performance
- **OR-3.2.1**: Initial load < 1s
- **OR-3.2.2**: UI updates < 100ms
- **OR-3.2.3**: Message send latency < 200ms
- **OR-3.2.4**: 60fps scrolling

### 3.3 Build & Deployment
- **OR-3.3.1**: Build: `npx expo export --platform web`
- **OR-3.3.2**: Deploy: Static files to CDN
- **OR-3.3.3**: Environment: `EXPO_PUBLIC_BACKEND_URL`

---

## 4. Use Cases

See [USECASES.md](./USECASES.md) for detailed behavioral specifications using Gherkin syntax.

**Coverage:**
- UC-1: User Login
- UC-2: View Conversation List
- UC-3: Start New Conversation
- UC-4: Send and Receive Messages
- UC-5: Real-Time Updates via WebSocket
- UC-6: Typing Indicators
- UC-7: Message Status Indicators
- UC-8: Archive Conversation
- UC-9: Delete Conversation
- UC-10: Logout

---

## 5. Definition of Done

- [ ] Build succeeds without errors
- [ ] All routes render correctly
- [ ] Login/logout works
- [ ] Real-time messaging works
- [ ] Conversations persist after refresh
- [ ] TypeScript strict mode passes
- [ ] No console errors

---

*Last updated: 2024-12-07*
