import axios, { type AxiosInstance } from 'axios';
import EventSource from 'eventsource';

interface KelifyConfig {
  apiKey: string;
  baseUrl?: string;
}

interface ConversationResponse {
  conversation_id: string;
  created_at: string;
}

interface Message {
  role: 'user' | 'assistant';
  content: string;
  timestamp?: string;
}

interface Property {
  id: string;
  title: string;
  address?: string;
  price: number;
  operation: 'rent' | 'sale';
  home_type:
    | 'flat'
    | 'house'
    | 'studio'
    | 'duplex'
    | 'penthouse'
    | 'chalet'
    | 'country_house'
    | 'loft';
  rooms?: number;
  bathrooms?: number;
  size?: number;
  latitude?: number;
  longitude?: number;
  photos: string[];
  url: string;
}

interface SearchParams {
  operation?: 'rent' | 'sale';
  rooms?: number[];
  min_price?: number;
  max_price?: number;
  min_size?: number;
  max_size?: number;
  home_types?: string[];
  area?: any;
  sort_by?: 'price' | 'size' | 'date' | 'rooms' | 'bathrooms';
  sort_direction?: 'asc' | 'desc';
  days_ago?: number;
  features?: string[];
  furnishing?: 'furnished' | 'unfurnished' | 'kitchen_equipped';
  hide_professionals?: boolean;
  hide_seasonal_rentals?: boolean;
  no_agency_commission?: boolean;
}

interface Usage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
}

interface ConversationDetails {
  conversation_id: string;
  created_at: string;
  updated_at?: string;
  title?: string;
  messages: Message[];
  usage: Usage;
}

interface MessageRequest {
  message: string;
  stream?: boolean;
}

interface MessageResponse {
  conversation_id: string;
  title?: string;
  message: Message;
  search_results?: {
    count: number;
    properties: Property[];
    search_params: SearchParams;
  };
  usage: Usage;
}

interface SSEEvent {
  event: string;
  data: any;
}

export class KelifyClient {
  private api: AxiosInstance;
  private baseUrl: string;

  constructor(config: KelifyConfig) {
    this.baseUrl = config.baseUrl || 'https://api.kelify.com';
    this.api = axios.create({
      baseURL: this.baseUrl,
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      timeout: 30000,
    });
  }

  async createConversation(): Promise<ConversationResponse> {
    try {
      const response = await this.api.post('/v1/conversations');
      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        throw new Error(`Kelify API Error: ${error.response?.data?.error || error.message}`);
      }
      throw error;
    }
  }

  async getConversation(conversationId: string): Promise<ConversationDetails> {
    try {
      const response = await this.api.get(`/v1/conversations/${conversationId}`);
      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        if (error.response?.status === 404) {
          throw new Error(`Conversation not found: ${conversationId}`);
        }
        throw new Error(`Kelify API Error: ${error.response?.data?.error || error.message}`);
      }
      throw error;
    }
  }

  async sendMessage(
    conversationId: string,
    message: string,
    stream: boolean = true,
  ): Promise<MessageResponse> {
    if (stream) {
      throw new Error('Streaming is not supported in this method. Use sendMessageStream instead.');
    }

    try {
      const response = await this.api.post(`/v1/conversations/${conversationId}/messages`, {
        message,
        stream: false,
      } as MessageRequest);
      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        if (error.response?.status === 404) {
          throw new Error(`Conversation not found: ${conversationId}`);
        }
        if (error.response?.status === 403) {
          throw new Error(`Conversation is closed: ${conversationId}`);
        }
        throw new Error(`Kelify API Error: ${error.response?.data?.error || error.message}`);
      }
      throw error;
    }
  }

  async sendMessageStream(
    conversationId: string,
    message: string,
    onDelta?: (content: string) => void,
    onSearchResults?: (results: {
      count: number;
      properties: Property[];
      search_params: SearchParams;
    }) => void,
    onStatus?: (status: string) => void,
    onError?: (error: string) => void,
  ): Promise<MessageResponse> {
    return new Promise((resolve, reject) => {
      const url = `${this.baseUrl}/v1/conversations/${conversationId}/messages`;
      const eventSource = new EventSource(url, {
        headers: {
          Authorization: `Bearer ${this.api.defaults.headers.Authorization}`,
        },
      });

      let accumulatedContent = '';
      let finalData: any = null;

      eventSource.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);

          switch (event.type) {
            case 'status':
              if (onStatus) {
                onStatus(data.status);
              }
              break;

            case 'delta':
              if (data.content) {
                accumulatedContent += data.content;
                if (onDelta) {
                  onDelta(data.content);
                }
              }
              break;

            case 'search_results':
              if (onSearchResults) {
                onSearchResults(data);
              }
              break;

            case 'done':
              finalData = {
                conversation_id: data.conversation_id,
                title: data.title,
                message: {
                  role: 'assistant' as const,
                  content: accumulatedContent,
                },
                usage: data.usage,
              };
              eventSource.close();
              resolve(finalData);
              break;

            case 'error': {
              const errorMessage = data.error || 'Unknown error occurred';
              if (onError) {
                onError(errorMessage);
              }
              eventSource.close();
              reject(new Error(errorMessage));
              break;
            }
          }
        } catch (parseError) {
          console.error('Error parsing SSE data:', parseError);
        }
      };

      eventSource.onerror = (error) => {
        eventSource.close();
        reject(new Error(`SSE connection error: ${error}`));
      };

      eventSource.onopen = () => {
        eventSource.send(
          JSON.stringify({
            message,
            stream: true,
          } as MessageRequest),
        );
      };
    });
  }
}

export function createKelifyClient(config: KelifyConfig): KelifyClient {
  return new KelifyClient(config);
}
