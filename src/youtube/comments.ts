import { google } from 'googleapis';
import dotenv from 'dotenv';
import { trackQuota, assertQuota } from '../db/quota';
import { googleApiProxyConfig } from '../proxy/manager';

dotenv.config();

function getYoutube() {
  const p = googleApiProxyConfig();
  return google.youtube({
    version: 'v3',
    auth: process.env.YOUTUBE_API_KEY,
    ...(p.agent ? { fetchOptions: { agent: p.agent } } : {}),
  } as any);
}

export interface FetchedComment {
  youtube_comment_id: string;
  author_name: string;
  author_channel_id?: string;
  is_channel_owner: boolean;
  text: string;
  like_count: number;
  reply_count: number;
  published_at: string;
  parent_id?: string;
  replies?: FetchedComment[];
}

/**
 * Получить топ комментарии видео
 * @param videoId  YouTube video ID
 * @param maxTop   Сколько top-level комментариев (макс 100)
 * @param fetchReplies  Подгружать ли ответы на топ-комментарии
 */
export async function fetchTopComments(
  videoId: string,
  maxTop = 20,
  fetchReplies = true
): Promise<FetchedComment[]> {

  // Шаг 1: получаем top-level комментарии отсортированные по relevance
  assertQuota('commentThreads.list');
  const res = await getYoutube().commentThreads.list({
    part: ['snippet', 'replies'],
    videoId,
    order: 'relevance',
    maxResults: Math.min(maxTop, 100),
  });

  trackQuota('commentThreads.list', videoId);
  const threads = res.data.items || [];
  const comments: FetchedComment[] = [];

  for (const thread of threads) {
    const top = thread.snippet?.topLevelComment?.snippet;
    if (!top) continue;

    const topComment: FetchedComment = {
      youtube_comment_id: thread.snippet!.topLevelComment!.id!,
      author_name:        top.authorDisplayName || 'Unknown',
      author_channel_id:  top.authorChannelId?.value ?? undefined,
      is_channel_owner:   !!thread.snippet?.canReply === false ? false :
                          top.authorChannelId?.value === (thread.snippet as any)?.videoOwnerChannelId,
      text:               top.textDisplay || '',
      like_count:         top.likeCount || 0,
      reply_count:        thread.snippet?.totalReplyCount || 0,
      published_at:       top.publishedAt || new Date().toISOString(),
      replies:            [],
    };

    // Ответы уже могут быть в thread.replies (до 5 штук)
    if (fetchReplies && thread.replies?.comments?.length) {
      topComment.replies = thread.replies.comments.map(r => ({
        youtube_comment_id: r.id!,
        author_name:        r.snippet?.authorDisplayName || 'Unknown',
        author_channel_id:  r.snippet?.authorChannelId?.value ?? undefined,
        is_channel_owner:   r.snippet?.authorChannelId?.value === (thread.snippet as any)?.videoOwnerChannelId,
        text:               r.snippet?.textDisplay || '',
        like_count:         r.snippet?.likeCount || 0,
        reply_count:        0,
        published_at:       r.snippet?.publishedAt || new Date().toISOString(),
        parent_id:          topComment.youtube_comment_id,
      }));
    }

    comments.push(topComment);
  }

  return comments;
}

/**
 * Получить только комментарии автора канала (pinned/responses)
 */
export async function fetchChannelOwnerComments(
  videoId: string,
  channelId: string
): Promise<FetchedComment[]> {
  const all = await fetchTopComments(videoId, 100, true);
  return all.filter(c =>
    c.is_channel_owner ||
    c.replies?.some(r => r.is_channel_owner)
  );
}
