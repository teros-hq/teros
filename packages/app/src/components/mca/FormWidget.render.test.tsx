import { render, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TamaguiProvider } from 'tamagui'
import config from '../../../tamagui.config'
// Initializes the global i18next instance (expo-localization is stubbed to
// en-US in vitest.setup.ts) so useTranslation resolves real English copy.
import '../../i18n'
import type { ToolCall } from '../chat/bubbles/types'
import { FormWidget } from './FormWidget'

/**
 * Inline user forms — the widget is
 * the only interactive surface of the request-user-input tool. Assert the
 * whole loop at render level: spec (tool input) → fields, submit → validated
 * payload through client.respondToForm, dismiss path, the read-only summary
 * from the tool output, the single-question variant and the wizard flow
 * (auto-advance on choice selection + final review step).
 */

const h = vi.hoisted(() => ({
  respondToForm: vi.fn(async (formRequestId: string) => ({ formRequestId, accepted: true })),
}))
vi.mock('../../services/terosClientSingleton', () => ({
  getTerosClient: () => ({ respondToForm: h.respondToForm }),
}))

// English copy (formWidget.* in src/i18n/locales/en-US.json)
const T = {
  submit: 'Send',
  dismiss: "I'd rather answer in the chat",
  notesLabel: 'Notes',
  notesPlaceholder: 'Anything to add or clarify? (optional)',
  validationIntro: 'Please review:',
  dismissedTitle: 'Form dismissed — answered in the chat instead',
  back: 'Back',
  next: 'Next',
  review: 'Review your answers',
  yes: 'Yes',
}

const SPEC = {
  title: 'Booking',
  fields: [
    { id: 'name', type: 'text', label: 'Full name', required: true, placeholder: 'Your name' },
    {
      id: 'meal',
      type: 'select',
      label: 'Meal',
      options: [
        { value: 'veg', label: 'Vegetarian' },
        { value: 'meat', label: 'Meat' },
      ],
    },
    { id: 'confirmed', type: 'checkbox', label: 'Confirm booking' },
  ],
}

function makeTool(overrides: Partial<ToolCall> = {}): ToolCall {
  return {
    toolCallId: 'tc_form',
    toolName: 'request-user-input',
    input: SPEC,
    status: 'pending_user_input',
    formRequestId: 'form_1',
    ...overrides,
  }
}

function renderWidget(tool: ToolCall) {
  return render(
    <TamaguiProvider config={config} defaultTheme="dark">
      <FormWidget tool={tool} />
    </TamaguiProvider>,
  )
}

describe('FormWidget (render)', () => {
  beforeEach(() => {
    h.respondToForm.mockClear()
  })

  it('renders the live form: title, fields, options, always-on Notes and submit', () => {
    const { getByText, getByPlaceholderText } = renderWidget(makeTool())
    expect(getByText('Booking')).toBeTruthy()
    expect(getByText('Full name')).toBeTruthy()
    expect(getByText('Vegetarian')).toBeTruthy()
    expect(getByText('Confirm booking')).toBeTruthy()
    expect(getByText(T.notesLabel)).toBeTruthy()
    expect(getByPlaceholderText(T.notesPlaceholder)).toBeTruthy()
    expect(getByText(T.submit)).toBeTruthy()
    expect(getByText(T.dismiss)).toBeTruthy()
  })

  it('submits coerced values (select choice, checkbox boolean, trimmed notes)', async () => {
    const user = userEvent.setup()
    const { getByText, getByPlaceholderText } = renderWidget(makeTool())

    await user.type(getByPlaceholderText('Your name'), 'Ada')
    await user.click(getByText('Vegetarian'))
    await user.click(getByText('Confirm booking'))
    await user.type(getByPlaceholderText(T.notesPlaceholder), '  be quick  ')
    await user.click(getByText(T.submit))

    await waitFor(() => expect(h.respondToForm).toHaveBeenCalledTimes(1))
    expect(h.respondToForm).toHaveBeenCalledWith('form_1', {
      values: { name: 'Ada', meal: 'veg', confirmed: true },
      notes: 'be quick',
    })
  })

  it('blocks submit client-side when a required field is missing', async () => {
    const user = userEvent.setup()
    const { getByText } = renderWidget(makeTool())

    await user.click(getByText(T.submit))

    expect(getByText(T.validationIntro)).toBeTruthy()
    expect(getByText(/'name' is required/)).toBeTruthy()
    expect(h.respondToForm).not.toHaveBeenCalled()
  })

  it('shows server-side validation errors and re-enables the form', async () => {
    h.respondToForm.mockResolvedValueOnce({
      formRequestId: 'form_1',
      accepted: false,
      errors: ["'name' is required"],
    } as any)
    const user = userEvent.setup()
    const { getByText, getByPlaceholderText } = renderWidget(makeTool())

    // Passes client validation, gets rejected by the server (race/spec drift).
    await user.type(getByPlaceholderText('Your name'), 'Ada')
    await user.click(getByText(T.submit))

    await waitFor(() => expect(getByText(/'name' is required/)).toBeTruthy())
    expect(getByText(T.submit)).toBeTruthy() // not stuck on "Sending…"
  })

  it('dismiss sends { dismissed: true } without values', async () => {
    const user = userEvent.setup()
    const { getByText } = renderWidget(makeTool())

    await user.click(getByText(T.dismiss))

    await waitFor(() => expect(h.respondToForm).toHaveBeenCalledTimes(1))
    expect(h.respondToForm).toHaveBeenCalledWith('form_1', { dismissed: true })
  })

  it('renders the read-only summary from the tool output once completed', () => {
    const tool = makeTool({
      status: 'completed',
      formRequestId: undefined,
      output: JSON.stringify({
        submitted: true,
        values: { name: 'Ada', meal: 'veg', confirmed: true },
        notes: 'be quick',
      }),
    })
    const { getByText, queryByText } = renderWidget(tool)

    expect(getByText('Ada')).toBeTruthy()
    expect(getByText('Vegetarian')).toBeTruthy() // option label, not raw value
    expect(getByText(T.yes)).toBeTruthy()
    expect(getByText('be quick')).toBeTruthy()
    expect(queryByText(T.submit)).toBeNull()
    expect(queryByText(T.dismiss)).toBeNull()
  })

  it('renders a muted note when the form was dismissed', () => {
    const tool = makeTool({
      status: 'completed',
      formRequestId: undefined,
      output: JSON.stringify({ submitted: false, dismissed: true }),
    })
    const { getByText } = renderWidget(tool)
    expect(getByText(T.dismissedTitle)).toBeTruthy()
  })

  it('renders nothing for the headless bypass result', () => {
    const tool = makeTool({
      status: 'completed',
      formRequestId: undefined,
      output: JSON.stringify({ available: false, reason: 'headless' }),
    })
    const { container } = renderWidget(tool)
    expect(container.textContent).toBe('')
  })

  // ── single-question variant (question-by-question flows) ─────────────────

  it('a single select field renders as a compact question: label in the header, not repeated', async () => {
    const user = userEvent.setup()
    const { getAllByText, getByText } = renderWidget(
      makeTool({
        input: {
          fields: [
            {
              id: 'size',
              type: 'radio',
              label: 'Which size do you want?',
              options: [
                { value: 's', label: 'Small' },
                { value: 'l', label: 'Large' },
              ],
            },
          ],
        },
      }),
    )

    // Header shows the question; the label is NOT repeated above the chips.
    expect(getAllByText('Which size do you want?')).toHaveLength(1)
    expect(getByText(T.submit)).toBeTruthy() // explicit Send — tap only selects

    await user.click(getByText('Large'))
    await user.click(getByText(T.submit))
    await waitFor(() => expect(h.respondToForm).toHaveBeenCalledTimes(1))
    expect(h.respondToForm).toHaveBeenCalledWith('form_1', {
      values: { size: 'l' },
      notes: undefined,
    })
  })

  // ── wizard presentation ───────────────────────────────────────────────────

  const WIZARD_SPEC = {
    title: 'Trip details',
    presentation: 'wizard',
    fields: [
      { id: 'destination', type: 'text', label: 'Destination', required: true, placeholder: 'City' },
      {
        id: 'transport',
        type: 'radio',
        label: 'Transport',
        options: [
          { value: 'train', label: 'Train' },
          { value: 'plane', label: 'Plane' },
        ],
      },
      { id: 'days', type: 'number', label: 'Days', placeholder: 'How many days' },
    ],
  }

  it('wizard: one field per step, progress badge, choice auto-advances, review step verifies, then Send', async () => {
    const user = userEvent.setup()
    const { getByText, queryByText, getByPlaceholderText, queryByPlaceholderText } = renderWidget(
      makeTool({ input: WIZARD_SPEC }),
    )

    // Step 1: only the first field; progress counts fields + review (no Send yet).
    expect(getByText('1 / 4')).toBeTruthy()
    expect(getByPlaceholderText('City')).toBeTruthy()
    expect(queryByText('Train')).toBeNull()
    expect(queryByText(T.submit)).toBeNull()

    // Required field empty → Next blocks with the validation error.
    await user.click(getByText(T.next))
    expect(getByText(/'destination' is required/)).toBeTruthy()

    await user.type(getByPlaceholderText('City'), 'Tokyo')
    await user.click(getByText(T.next))

    // Step 2 (choice): selecting an option auto-advances — no Next click needed.
    expect(getByText('2 / 4')).toBeTruthy()
    await user.click(getByText('Train'))
    expect(getByText('3 / 4')).toBeTruthy()
    expect(getByPlaceholderText('How many days')).toBeTruthy()

    await user.type(getByPlaceholderText('How many days'), '5')
    await user.click(getByText(T.next))

    // Review step: every answer listed, Notes + Send appear.
    expect(getByText('4 / 4')).toBeTruthy()
    expect(getByText(T.review)).toBeTruthy()
    expect(getByText('Tokyo')).toBeTruthy()
    expect(getByText('Train')).toBeTruthy() // option label
    expect(getByText('5')).toBeTruthy()
    expect(getByPlaceholderText(T.notesPlaceholder)).toBeTruthy()

    // Tapping a review row jumps back to that step to edit it.
    await user.click(getByText('Tokyo'))
    expect(getByPlaceholderText('City')).toHaveProperty('value', 'Tokyo')
    await user.click(getByText(T.next))
    await user.click(getByText(T.next)) // choice already answered → Next passes
    expect(queryByPlaceholderText('How many days')).toBeTruthy()
    await user.click(getByText(T.next))

    await user.click(getByText(T.submit))
    await waitFor(() => expect(h.respondToForm).toHaveBeenCalledTimes(1))
    expect(h.respondToForm).toHaveBeenCalledWith('form_1', {
      values: { destination: 'Tokyo', transport: 'train', days: 5 },
      notes: undefined,
    })
  })
})
