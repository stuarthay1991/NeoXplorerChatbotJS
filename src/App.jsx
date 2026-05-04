import { useState } from 'react'
import './App.css'
import { useChat } from '@ai-sdk/react'
import { DefaultChatTransport } from 'ai'
import useStyles from './css/useStyles.js';
import oncologo from './images/NeoXplorer.png';
import homeicon from './images/home.png';
import infoicon from './images/info.png';
import downloadicon from './images/download.png';
import contacticon from './images/contact.png';
import pubicon from './images/pub.png';

const chatApi =
  import.meta.env.VITE_CHAT_API_URL?.replace(/\/$/, '') ?? ''

function getMessageText(message) {
  return message.parts
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('')
}

function TopNav() {
  const classes = useStyles();
  var oncoimg = <img src={oncologo} alt="Logo" width="202" height="50"></img>;

  const onSelectSplash = (e) => {
    window.location.href = "https://www.altanalyze.org/ICGS/Oncosplice/splash/";
  }

  return (
    <>
      <style>{`
        ul.topnav {
          list-style: none;
          display: flex;
          gap: 10px;
        }
        ul.topnav li.topnav {
          display: inline;
          margin: 7px;
          padding: 1px;
        }
        ul.topnav li.topnav a.topnav {
          color: white;
          text-decoration: none;
          display: flex;
          font-size: 21px;
          align-items: center;
        }
        ul li a img {
          align-items: center;
          margin-right: 10px;
        }
      `}</style>
      <div className={classes.mainpane} style={{ fontFamily: 'Roboto', background: "#0073aa", color: "#0073aa", display: "flex", alignItems: "center", justifyContent: "space-between"}}>
        <div className={classes.cntr_special} onClick={onSelectSplash} style={{cursor: "pointer"}} title="Go to Splash Page">{oncoimg}</div>
        <div className={classes.mainpane_margin_type1}>
        </div>
        <div>
        <ul class="topnav">
                      <li class="topnav"><a href="#" class="topnav"><img src={homeicon} height="30" width="30" alt="Home" class="icon"></img>Home</a></li>
                      <li class="topnav"><a href="#" class="topnav"><img src={infoicon} height="30" width="30" alt="About" class="icon"></img>About</a></li>
                      <li class="topnav"><a href="https://pubmed.ncbi.nlm.nih.gov/40333990/" class="topnav" target="_blank"><img src={pubicon} height="30" width="30" alt="Publications" class="icon"></img>Publications</a></li>
                      <li class="topnav"><a class="topnav" href="https://www.synapse.org/Synapse:syn12103642/files/" target="_blank"><img src={downloadicon} height="30" width="30" alt="Downloads" class="icon"></img>Downloads</a></li>
                      <li class="topnav"><a class="topnav" href="mailto: altanalyze@gmail.com"><img src={contacticon} height="30" width="30" alt="Contact" class="icon"></img>Contact</a></li>
        </ul>
        <div id="LoadingStatusDisplay" style={{display: "none"}}>Loading...</div>
        </div>
      </div>
    </>
  );
}

function App() {
  const [input, setInput] = useState('')

  const { messages, sendMessage, status } = useChat({
    transport: new DefaultChatTransport({
      api: chatApi ? `${chatApi}/api/chat` : '/api/chat',
    }),
  })

  const busy = status === 'streaming' || status === 'submitted'

  return (
    <>
    <TopNav></TopNav>
    <div
      style={{
        width: 'min(94vw, 1280px)',
        maxWidth: '100%',
        margin: '15px auto 0',
        padding: 'clamp(12px, 2.5vw, 28px)',
        boxSizing: 'border-box',
        fontFamily: 'system-ui, -apple-system, sans-serif',
        textAlign: 'left',
        alignSelf: 'stretch',
      }}
    >
      <h1 style={{ marginTop: 0, marginBottom: '1rem', fontSize: 'clamp(1.25rem, 2.5vw, 1.75rem)' }}>
        NeoXplorer Chatbot
      </h1>

      <div
        style={{
          height: 'clamp(22rem, 58vh, 46rem)',
          minHeight: '320px',
          overflowY: 'auto',
          border: '1px solid #ccc',
          borderRadius: '8px',
          padding: 'clamp(12px, 1.5vw, 18px)',
          marginBottom: '12px',
          background: '#fafafa',
          textAlign: 'left',
        }}
      >
        {messages.map((message) => (
          <div
            key={message.id}
            style={{
              marginBottom: '10px',
              textAlign: 'left',
            }}
          >
            <strong>{message.role === 'user' ? 'You: ' : 'NeoXplorer Chatbot: '}</strong>
            <span>{getMessageText(message)}</span>
          </div>
        ))}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault()
          const text = input.trim()
          if (!text || busy) return
          sendMessage({ text })
          setInput('')
        }}
        style={{ display: 'flex', gap: '10px' }}
      >
        <input
          style={{ flexGrow: 1, padding: '8px' }}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Type your message..."
        />
        <button type="submit" style={{ padding: '8px 16px' }} disabled={busy}>
          {busy ? '…' : 'Send'}
        </button>
      </form>
    </div>
    </>
  )
}

export default App
