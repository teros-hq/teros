import type { forms_v1 } from 'googleapis';

/**
 * Format a form response answer for display.
 * Handles text, scale, choice, and file upload answer types.
 */
export function formatAnswer(answer: forms_v1.Schema$Answer): Record<string, any> {
  const result: Record<string, any> = {};

  if (answer.textAnswers) {
    result.type = 'text';
    result.values = answer.textAnswers.answers?.map((a) => a.value) ?? [];
  } else if (answer.scaleAnswer) {
    result.type = 'scale';
    result.value = answer.scaleAnswer.value;
  } else if (answer.choiceAnswers) {
    result.type = 'choice';
    result.values = answer.choiceAnswers.answers?.map((a) => a.value) ?? [];
  } else if (answer.fileUploadAnswers) {
    result.type = 'file_upload';
    result.files = answer.fileUploadAnswers.answers?.map((a) => ({
      fileId: a.fileId,
      fileName: a.fileName,
      mimeType: a.mimeType,
    })) ?? [];
  } else if (answer.grade) {
    result.type = 'grade';
    result.score = answer.grade.score;
    result.correct = answer.grade.correct;
  }

  return result;
}

/**
 * Format a form item for display, extracting question type and options.
 */
export function formatItem(item: forms_v1.Schema$Item): Record<string, any> {
  const result: Record<string, any> = {
    itemId: item.itemId,
    title: item.title,
    description: item.description,
  };

  if (item.questionItem) {
    const question = item.questionItem.question;
    result.type = 'question';
    result.required = question?.required ?? false;

    if (question?.choiceQuestion) {
      result.questionType = question.choiceQuestion.type; // RADIO, CHECKBOX, DROP_DOWN
      result.options = question.choiceQuestion.options?.map((o) => o.value) ?? [];
    } else if (question?.textQuestion) {
      result.questionType = question.textQuestion.paragraph ? 'PARAGRAPH' : 'SHORT_ANSWER';
    } else if (question?.scaleQuestion) {
      result.questionType = 'SCALE';
      result.scaleMin = question.scaleQuestion.low;
      result.scaleMax = question.scaleQuestion.high;
      result.scaleMinLabel = question.scaleQuestion.lowLabel;
      result.scaleMaxLabel = question.scaleQuestion.highLabel;
    } else if (question?.dateQuestion) {
      result.questionType = 'DATE';
      result.includeTime = question.dateQuestion.includeTime;
    } else if (question?.timeQuestion) {
      result.questionType = 'TIME';
    } else if (question?.fileUploadQuestion) {
      result.questionType = 'FILE_UPLOAD';
    } else if (question?.rowQuestion) {
      result.questionType = 'ROW';
    } else if (question?.ratingQuestion) {
      result.questionType = 'RATING';
    }
  } else if (item.questionGroupItem) {
    result.type = 'question_group';
    result.questions = item.questionGroupItem.questions?.map((q) => ({
      questionId: q.questionId,
      required: q.required,
      rowQuestion: q.rowQuestion?.title,
    })) ?? [];
  } else if (item.pageBreakItem) {
    result.type = 'page_break';
  } else if (item.textItem) {
    result.type = 'text';
  } else if (item.imageItem) {
    result.type = 'image';
  } else if (item.videoItem) {
    result.type = 'video';
  }

  return result;
}
