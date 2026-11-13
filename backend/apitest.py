import os
from openai import OpenAI
from dotenv import load_dotenv

# Load your .env file
load_dotenv()

# Change "OPENAI_API_KEY" to whatever you named it in your .env file
api_key = os.getenv("OPENAI_API_KEY")

client = OpenAI(
    base_url="https://openrouter.ai/api/v1",
    api_key=api_key,
)

try:
    print(f"Testing with API Key: {api_key[:10]}...") # Shows just the start for safety
    
    completion = client.chat.completions.create(
        model="arcee-ai/trinity-large-preview:free",
        messages=[
            {"role": "user", "content": "Say 'Connection Successful'"}
        ]
    )
    print("Response:", completion.choices[0].message.content)
    
except Exception as e:
    print("\n❌ Connection Failed!")
    print(f"Error Details: {e}")