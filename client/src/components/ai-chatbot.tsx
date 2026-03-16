import { useState, useRef, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  MessageCircleIcon, SendIcon, XIcon, BotIcon, UserIcon, TrashIcon,
  Loader2Icon, TicketIcon, MapPinIcon, TrendingUpIcon, CheckCircle2Icon,
  MicIcon, MicOffIcon, Volume2Icon, VolumeXIcon
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { queryClient } from "@/lib/queryClient";
import { apiRequest } from "@/lib/queryClient";
import { useTranslation } from "@/components/language-provider";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  suggestions?: string[];
  action?: string;
  bookingDraft?: {
    sourceId: number;
    sourceName: string;
    destId: number;
    destName: string;
    count: number;
    totalFare: number;
  };
}

const INITIAL_SUGGESTIONS = [
  "Next train timing",
  "Plan a route",
  "Book a ticket to Indiranagar",
  "Crowd levels now",
];

function TypingDots() {
  return (
    <div className="flex items-center gap-1 px-1 py-0.5">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="w-1.5 h-1.5 rounded-full bg-muted-foreground/50 inline-block animate-bounce"
          style={{ animationDelay: `${i * 0.15}s`, animationDuration: "0.8s" }}
        />
      ))}
    </div>
  );
}

function BookingCard({ draft, onConfirm, onCancel, isLoading }: { 
  draft: NonNullable<ChatMessage["bookingDraft"]>, 
  onConfirm: () => void, 
  onCancel: () => void,
  isLoading: boolean
}) {
  return (
    <div className="mt-3 p-3.5 rounded-xl border border-primary/20 bg-primary/5 flex flex-col gap-3">
      <div className="flex items-center gap-2 text-primary">
        <TicketIcon className="w-4 h-4" />
        <span className="text-xs font-semibold uppercase tracking-wider">Booking Preview</span>
      </div>
      
      <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
        <div className="flex flex-col gap-0.5">
          <span className="text-[10px] text-muted-foreground uppercase">From</span>
          <span className="text-sm font-medium line-clamp-1">{draft.sourceName}</span>
        </div>
        <div className="flex flex-col items-center px-1">
          <TrendingUpIcon className="w-3.5 h-3.5 text-muted-foreground/40 rotate-90" />
        </div>
        <div className="flex flex-col gap-0.5 text-right">
          <span className="text-[10px] text-muted-foreground uppercase">To</span>
          <span className="text-sm font-medium line-clamp-1">{draft.destName}</span>
        </div>
      </div>

      <div className="flex items-center justify-between pt-2 border-t border-primary/10">
        <div className="flex flex-col">
          <span className="text-[10px] text-muted-foreground uppercase">Passengers</span>
          <span className="text-sm font-semibold">{draft.count}</span>
        </div>
        <div className="flex flex-col text-right">
          <span className="text-[10px] text-muted-foreground uppercase">Total Fare</span>
          <span className="text-lg font-bold text-primary">₹{draft.totalFare}</span>
        </div>
      </div>

      <div className="flex gap-2 mt-1">
        <Button 
          size="sm" 
          variant="outline" 
          className="flex-1 h-8 text-xs" 
          onClick={onCancel}
          disabled={isLoading}
        >
          Cancel
        </Button>
        <Button 
          size="sm" 
          className="flex-1 h-8 text-xs gap-1.5" 
          onClick={onConfirm}
          disabled={isLoading}
        >
          {isLoading ? <Loader2Icon className="w-3 h-3 animate-spin" /> : <CheckCircle2Icon className="w-3 h-3" />}
          Confirm Booking
        </Button>
      </div>
    </div>
  );
}

function MessageBubble({ msg, onSuggestion, onConfirmBooking, onCancelBooking, isBookingLoading }: { 
  msg: ChatMessage; 
  onSuggestion: (s: string) => void;
  onConfirmBooking: (draft: NonNullable<ChatMessage["bookingDraft"]>) => void;
  onCancelBooking: () => void;
  isBookingLoading: boolean;
}) {
  const isUser = msg.role === "user";
  const lines = msg.content.split("\n");

  return (
    <div className={`flex gap-2 ${isUser ? "justify-end" : "justify-start"}`}>
      {!isUser && (
        <div className="flex-shrink-0 w-6 h-6 rounded-full bg-primary/15 flex items-center justify-center mt-1">
          <BotIcon className="w-3 h-3 text-primary" />
        </div>
      )}
      <div className={`flex flex-col gap-1.5 max-w-[85%] ${isUser ? "items-end" : "items-start"}`}>
        <div
          className={`rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed shadow-sm ${
            isUser
              ? "bg-primary text-primary-foreground rounded-tr-sm"
              : "bg-muted/80 text-foreground rounded-tl-sm shadow-inner-white"
          }`}
        >
          {lines.map((line, i) => {
            const trimmed = line.trim();
            if (!trimmed) return <div key={i} className="h-1.5" />;
            const isBullet = trimmed.startsWith("•") || trimmed.startsWith("-");
            const isNumbered = /^\d+\./.test(trimmed);
            if (isBullet || isNumbered) {
              return (
                <div key={i} className="flex gap-1.5 mt-0.5">
                  <span className="flex-shrink-0 mt-0.5 opacity-60 text-xs">{isBullet ? "•" : trimmed.match(/^\d+\./)?.[0]}</span>
                  <span>{isBullet ? trimmed.slice(1).trim() : trimmed.replace(/^\d+\.\s*/, "")}</span>
                </div>
              );
            }
            return <p key={i} className={i > 0 ? "mt-0.5" : ""}>{trimmed}</p>;
          })}

          {msg.bookingDraft && (
            <BookingCard 
              draft={msg.bookingDraft} 
              onConfirm={() => onConfirmBooking(msg.bookingDraft!)}
              onCancel={onCancelBooking}
              isLoading={isBookingLoading}
            />
          )}
        </div>
        {!isUser && msg.suggestions && msg.suggestions.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mt-0.5">
            {msg.suggestions.map((s, i) => (
              <button
                key={i}
                onClick={() => onSuggestion(s)}
                className="text-[11px] px-2.5 py-1 rounded-full border border-primary/25 text-primary bg-primary/5 cursor-pointer transition-colors hover:bg-primary/15"
                style={{ lineHeight: 1.4 }}
              >
                {s}
              </button>
            ))}
          </div>
        )}
      </div>
      {isUser && (
        <div className="flex-shrink-0 w-6 h-6 rounded-full bg-primary/15 flex items-center justify-center mt-1">
          <UserIcon className="w-3 h-3 text-primary" />
        </div>
      )}
    </div>
  );
}

export function AIChatbot() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [isOpen, setIsOpen] = useState(false);
  const [hasUnread, setHasUnread] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      role: "assistant",
      content: "Hello! I'm your METRO MIND Assistant. I can help you find routes, check timings, or book tickets. Type a message below to get started!",
      suggestions: INITIAL_SUGGESTIONS,
    },
  ]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isBookingLoading, setIsBookingLoading] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [isMuted, setIsMuted] = useState(() => {
    if (typeof window !== "undefined") {
      return localStorage.getItem("chat-muted") === "true";
    }
    return false;
  });
  
  const [conversationState, setConversationState] = useState<{
    intent?: string;
    sourceStation?: { id: number; name: string };
    destStation?: { id: number; name: string };
    passengers?: number;
  }>({});

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const recognitionRef = useRef<any>(null);

  useEffect(() => {
    if (typeof window !== "undefined") {
      const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
      if (SpeechRecognition) {
        recognitionRef.current = new SpeechRecognition();
        recognitionRef.current.continuous = false;
        recognitionRef.current.interimResults = false;
        recognitionRef.current.lang = "en-IN";

        recognitionRef.current.onresult = (event: any) => {
          const transcript = event.results[0][0].transcript;
          setInput(transcript);
          sendMessage(transcript);
          setIsListening(false);
        };

        recognitionRef.current.onerror = () => {
          setIsListening(false);
        };

        recognitionRef.current.onend = () => {
          setIsListening(false);
        };
      }
    }
  }, []);

  const speak = (text: string) => {
    if (isMuted || !("speechSynthesis" in window)) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 1.0;
    utterance.pitch = 1.0;
    window.speechSynthesis.speak(utterance);
  };

  useEffect(() => {
    const lastMessage = messages[messages.length - 1];
    if (lastMessage && lastMessage.role === "assistant" && isOpen && !isLoading) {
      speak(lastMessage.content);
    }
  }, [messages, isOpen, isLoading, isMuted]);

  useEffect(() => {
    localStorage.setItem("chat-muted", isMuted.toString());
    if (isMuted) window.speechSynthesis.cancel();
  }, [isMuted]);

  useEffect(() => {
    if (isOpen) messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isOpen, isLoading]);

  useEffect(() => {
    if (isOpen) {
      setHasUnread(false);
    }
  }, [isOpen]);

  const sendMessage = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || isLoading) return;

    setMessages((prev) => [...prev, { role: "user", content: trimmed }]);
    setInput("");
    setIsLoading(true);

    try {
      const res = await apiRequest("POST", "/api/assistant", { 
        message: trimmed,
        conversationState,
        isVoice: false
      });
      const data = await res.json();
      
      const botMsg: ChatMessage = {
        role: "assistant",
        content: data.reply,
        suggestions: data.suggestions ?? [],
        action: data.action,
      };
      
      setMessages((prev) => [...prev, botMsg]);
      setConversationState(data.nextState || {});
      
      if (data.bookingDraft) {
        // If we get a booking draft, we might want to clear previous unconfirmed drafts
        setMessages((prev) => prev.map(m => m.bookingDraft ? { ...m, bookingDraft: undefined } : m));
        
        const bookingMsg: ChatMessage = {
          role: "assistant",
          content: `I've prepared a booking for you from ${data.bookingDraft.sourceName} to ${data.bookingDraft.destName}. Please confirm the details below.`,
          bookingDraft: data.bookingDraft,
          suggestions: ["Cancel booking", "Change count to 2"]
        };
        setMessages((prev) => [...prev, bookingMsg]);
        // Speak booking info specifically
        speak(`I've prepared a booking from ${data.bookingDraft.sourceName} to ${data.bookingDraft.destName}. Please confirm the details.`);
      }
      
      if (!isOpen) setHasUnread(true);
      
    } catch {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: "Sorry, I had trouble connecting. Please try again." },
      ]);
    } finally {
      setIsLoading(false);
    }
  };

  const handleConfirmBooking = async (draft: NonNullable<ChatMessage["bookingDraft"]>) => {
    setIsBookingLoading(true);
    try {
      const res = await apiRequest("POST", "/api/tickets", {
        sourceStationId: draft.sourceId,
        destStationId: draft.destId,
        passengers: draft.count,
        paymentMethod: "wallet"
      });
      
      if (res.ok) {
        toast({
          title: "Ticket Booked!",
          description: `Successfully booked ${draft.count} ticket(s) to ${draft.destName}.`,
        });
        
        // Add success message to chat
        setMessages((prev) => [
          ...prev.map(m => m.bookingDraft ? { ...m, bookingDraft: undefined } : m),
          { 
            role: "assistant", 
            content: `Great! I've successfully booked your ticket from ${draft.sourceName} to ${draft.destName}. You can find it in your "My Tickets" section. Is there anything else I can help with?` 
          }
        ]);
        
        // Refresh wallet balance and tickets
        queryClient.invalidateQueries({ queryKey: ["/api/tickets/my"] });
        queryClient.invalidateQueries({ queryKey: ["/api/user/me"] });
      } else {
        const error = await res.json();
        throw new Error(error.message || "Booking failed");
      }
    } catch (error: any) {
      toast({
        variant: "destructive",
        title: "Booking Failed",
        description: error.message,
      });
    } finally {
      setIsBookingLoading(false);
    }
  };

  const handleCancelBooking = () => {
    setMessages((prev) => 
      prev.map(m => m.bookingDraft ? { ...m, bookingDraft: undefined } : m)
    );
    setMessages((prev) => [
      ...prev,
      { role: "assistant", content: "No problem! Booking cancelled. What else can I help you with?" }
    ]);
    speak("Booking cancelled. What else can I help you with?");
  };

  const toggleListening = () => {
    if (isListening) {
      recognitionRef.current?.stop();
    } else {
      try {
        recognitionRef.current?.start();
        setIsListening(true);
      } catch (e) {
        console.error("Speech recognition failed to start", e);
      }
    }
  };

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage(input);
    }
  }

  function clearChat() {
    setConversationState({});
    setMessages([{
      role: "assistant",
      content: "Chat cleared! How can I help you today?",
      suggestions: INITIAL_SUGGESTIONS,
    }]);
  }

  const messageCount = messages.filter((m) => m.role === "user").length;

  return (
    <>
      <button
        className="fixed bottom-5 right-5 z-50 group hover:scale-105 transition-transform"
        style={{ display: isOpen ? "none" : "block" }}
        onClick={() => setIsOpen(true)}
        data-testid="button-chatbot-open"
      >
        <div className="relative">
          <div className="w-[52px] h-[52px] rounded-full bg-gradient-to-br from-primary to-primary/80 flex items-center justify-center shadow-lg">
            <MessageCircleIcon className="w-6 h-6 text-primary-foreground" />
          </div>
          {hasUnread && (
            <span className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-destructive border-2 border-background animate-pulse" />
          )}
        </div>
      </button>

      {isOpen && (
        <div className="fixed bottom-5 right-5 z-50 flex flex-col rounded-2xl border border-border bg-background shadow-2xl overflow-hidden"
          style={{ width: "360px", height: "540px" }}
        >
          {/* Header */}
          <div className="flex items-center justify-between gap-2 px-4 py-3 border-b bg-[#8ae2ff] flex-shrink-0">
            <div className="flex items-center gap-2.5">
              <div className="relative w-8 h-8 rounded-full bg-black/10 flex items-center justify-center flex-shrink-0">
                <BotIcon className="w-4 h-4 text-black" />
                <span className="absolute bottom-0 right-0 w-2.5 h-2.5 rounded-full bg-green-500 border-2 border-[#8ae2ff]" />
              </div>
              <div>
                <p className="text-sm font-bold leading-tight text-black">
                  METRO MIND Assistant
                </p>
                <div className="flex items-center gap-1 mt-0.5 text-black/70">
                  <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
                  <span className="text-[10px] font-medium leading-tight text-black/70">Online</span>
                </div>
              </div>
            </div>
            <div className="flex items-center gap-1 text-black/60">
              <button
                onClick={() => setIsMuted(!isMuted)}
                className="p-1.5 rounded-lg hover:bg-black/5 hover:text-black transition-colors"
                aria-label={isMuted ? "Unmute" : "Mute"}
              >
                {isMuted ? <VolumeXIcon className="w-4 h-4" /> : <Volume2Icon className="w-4 h-4" />}
              </button>
              {messageCount > 0 && (
                <button
                  onClick={clearChat}
                  className="p-1.5 rounded-lg hover:bg-black/5 hover:text-black transition-colors"
                  aria-label="Clear chat"
                >
                  <TrashIcon className="w-4 h-4" />
                </button>
              )}
              <button
                onClick={() => setIsOpen(false)}
                className="p-1.5 rounded-lg hover:bg-black/5 hover:text-black transition-colors"
                aria-label="Close chat"
              >
                <XIcon className="w-4 h-4" />
              </button>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3 min-h-0 bg-secondary/5">
            {messages.map((msg, i) => (
              <MessageBubble
                key={i}
                msg={msg}
                onSuggestion={(s) => sendMessage(s)}
                onConfirmBooking={handleConfirmBooking}
                onCancelBooking={handleCancelBooking}
                isBookingLoading={isBookingLoading}
              />
            ))}
            {isLoading && (
              <div className="flex gap-2 justify-start" data-testid="chat-loading">
                <div className="flex-shrink-0 w-6 h-6 rounded-full bg-primary/15 flex items-center justify-center mt-1">
                  <BotIcon className="w-3 h-3 text-primary" />
                </div>
                <div className="rounded-2xl rounded-tl-sm px-3.5 py-2.5 bg-muted/80">
                  <TypingDots />
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>

          <div className="flex items-center gap-2 px-3 py-3 border-t bg-card flex-shrink-0 relative">
            <Button
              size="icon"
              variant="ghost"
              onClick={toggleListening}
              className={`h-10 w-10 rounded-xl flex-shrink-0 transition-colors ${
                isListening ? "bg-red-500/10 text-red-500 animate-pulse" : "bg-muted/40 text-muted-foreground hover:text-primary hover:bg-primary/10"
              }`}
              disabled={isLoading}
            >
              {isListening ? <MicOffIcon className="w-4 h-4" /> : <MicIcon className="w-4 h-4" />}
            </Button>
            <Input
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={isListening ? "Listening..." : "Type your message..."}
              disabled={isLoading}
              className="flex-1 text-sm rounded-xl bg-muted/40 border-border/60 min-h-[40px]"
            />
            <Button
              size="icon"
              onClick={() => sendMessage(input)}
              disabled={isLoading || !input.trim()}
              className="h-10 w-10 rounded-xl flex-shrink-0 bg-primary text-primary-foreground"
            >
              {isLoading ? (
                 <Loader2Icon className="w-4 h-4 animate-spin" />
              ) : (
                 <SendIcon className="w-4 h-4" />
              )}
            </Button>
          </div>
        </div>
      )}
    </>
  );
}

