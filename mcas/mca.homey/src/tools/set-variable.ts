import type { ToolConfig } from '@teros/mca-sdk';
import { getHomeyApi, getSecrets, withTokenRefresh } from '../lib';

export const setVariable: ToolConfig = {
  annotations: { readOnlyHint: false },
  description: 'Set the value of a Homey logic variable by its ID. Use homey-get-variables to find variable IDs.',
  parameters: {
    type: 'object',
    properties: {
      variable_id: {
        type: 'string',
        description: 'Variable ID (UUID)',
      },
      value: {
        description: 'New value for the variable (string, number, or boolean — must match the variable type)',
      },
    },
    required: ['variable_id', 'value'],
  },
  handler: async (args, context) => {
    const secrets = await getSecrets(context);

    return withTokenRefresh(secrets, context, async (sec) => {
      const api = await getHomeyApi(sec);

      // Parse value to correct type (HTTP transport may stringify values)
      let parsedValue: any = args.value;
      if (typeof args.value === 'string') {
        if (args.value === 'true') parsedValue = true;
        else if (args.value === 'false') parsedValue = false;
        else if (!isNaN(Number(args.value)) && args.value !== '') parsedValue = Number(args.value);
      }

      await api.logic.updateVariable({
        id: args.variable_id as string,
        variable: { value: parsedValue },
      });

      return JSON.stringify(
        {
          success: true,
          variable_id: args.variable_id,
          value: parsedValue,
          message: `Variable updated successfully`,
        },
        null,
        2,
      );
    });
  },
};
